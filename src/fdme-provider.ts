import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import { isEqual, merge } from "lodash";
import * as path from "path";
import { EMPTY, Observable, defer, distinctUntilChanged, repeat, scan, share, switchMap, tap } from "rxjs";
import * as tesseract from "tesseract.js";
import { CaptureData } from "./fdme-capture";
import { MatchUpdate } from "./main";
import { exhaustMapLatest } from "./rx-utils";

export class FDMEProvider {

  private readonly windowScanDelayMs = 5000;

  private ocrMatcher: (data: Partial<CaptureData>) => Promise<MatchUpdate>;

  constructor(private testMode: boolean, private isDev: boolean) {
    const chronoMatcher = this.createOcrMatcher("0123456789:-", /^(\d+):(\d+)$/, p => {
      const min = Number(p[1]);
      const sec = Number(p[2]);
      return min >= 0 && sec >= 0 ? min * 60 + sec : undefined;
    });
    const scoreMatcher = this.createOcrMatcher("0123456789", /^(\d+)$/, p => Number(p[1]));

    this.ocrMatcher = async (captureData) => {
      const [chrono, homeScore, awayScore] = await Promise.all([
        chronoMatcher(captureData.chrono),
        scoreMatcher(captureData.homeScore),
        scoreMatcher(captureData.awayScore)
      ]);
      return { chrono, homeScore, awayScore, chronoStarted: captureData.chronoStarted } as MatchUpdate;
    };
  }

  private createOcrMatcher<T>(whiteList: string, regex: RegExp, map: (match: RegExpMatchArray) => T) {
    const scheduler = tesseract.createWorker("eng", tesseract.OEM.TESSERACT_ONLY, {
      langPath: path.join(__dirname, "..", "assets", "ocr-data"),
      cacheMethod: "none",
      gzip: false
    }).then(async worker => {
      await worker.setParameters({
        tessedit_char_whitelist: whiteList,
        tessedit_pageseg_mode: tesseract.PSM.SINGLE_WORD
      });
      const scheduler = tesseract.createScheduler();
      scheduler.addWorker(worker);
      return scheduler;
    });
    return async (input: Tesseract.ImageLike | undefined) => {
      if (!input) return undefined;
      try {
        const text = (await (await scheduler).addJob("recognize", input)).data.text.trim();
        const match = text.match(regex);
        if (!match) {
          console.warn(`Unrecognized data: '${text}' (against ${regex})`);
          //if (this.isDev) console.warn(`Data was: ${input}`);
        }
        return match ? map(match) : undefined;
      } catch (error) {
        console.error("OCR error: " + error);
        return undefined;
      }
    };
  }

  private observeWindowUpdates(sourceId: string): Observable<MatchUpdate> {
    return new Observable<Partial<CaptureData>>((sub) => {
      console.debug(`Creating capture window for '${sourceId}'`);
      const captureWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          preload: path.join(__dirname, "fdme-capture.js"),
          nodeIntegration: true
        }
      });
      const dataListener = (_: unknown, data: CaptureData) => sub.next(data);
      captureWindow.loadFile("assets/window.html", { hash: sourceId });
      if (this.isDev) {
        captureWindow.webContents.on("console-message", (_event, _level, message) => {
          console.debug(message);
        });
      }
      ipcMain.on("capture-data:" + sourceId, dataListener);
      return () => {
        ipcMain.off("capture-data:" + sourceId, dataListener);
        captureWindow.close();
      };
    }).pipe(
      exhaustMapLatest((captureData: CaptureData) => this.ocrMatcher(captureData)),
      scan((state, update) => merge({}, state, update), {} as MatchUpdate),
      distinctUntilChanged(isEqual),
      tap(u => { if (this.isDev) console.debug(`FDME update: ${JSON.stringify(u)}`); }),
      share()
    );
  }

  observeUpdates(): Observable<MatchUpdate | null> {
    return defer(async () => {
      if (this.testMode) return "@test";
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
      return sources.filter(w => w.name == "Feuille de Table").at(0)?.id ?? null;
    }).pipe(
      repeat({ delay: this.windowScanDelayMs }),
      distinctUntilChanged(),
      switchMap(sourceId => {
        if (this.isDev) console.debug(`FDME window: ${sourceId}`);
        return sourceId ? this.observeWindowUpdates(sourceId) : EMPTY;
      }),
      share()
    );
  }

}