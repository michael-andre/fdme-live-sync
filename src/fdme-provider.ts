import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import * as path from "path";
import { Observable, defer, distinctUntilChanged, map, mergeMap, merge as mergeObservables, pairwise, repeat, share, startWith, switchScan, tap } from "rxjs";
import * as tesseract from "tesseract.js";
import { CaptureData } from "./fdme-capture";
import { MatchUpdate } from "./main";
import { isEqual, merge } from "lodash";

export class FDMEProvider {

  private ocrMatcher: (data: Partial<CaptureData>) => Promise<Partial<MatchUpdate>>;

  constructor(private testMode: boolean) {
    const chronoMatcher = this.createOcrMatcher("0123456789:-", /^(\d+):(\d+)$/, p => {
      const min = Number(p[1]);
      const sec = Number(p[2]);
      return min >= 0 && sec >= 0 ? min * 60 + sec : undefined;
    });
    const scoreMatcher = this.createOcrMatcher("0123456789", /^(\d+)$/, p => Number(p[1]));
    const codeMatcher = this.createOcrMatcher("ABCDEFGHIJKLMNOPQRSTUVWXYZ", testMode ? /^(FTESTXX)$/ : /^([A-Z]{7})$/, p => p[1]);

    this.ocrMatcher = async (dataUrl) => {
      const [matchCode, chrono, homeScore, awayScore] = await Promise.all([
        codeMatcher(dataUrl.matchCode),
        chronoMatcher(dataUrl.chrono),
        scoreMatcher(dataUrl.homeScore),
        scoreMatcher(dataUrl.awayScore)
      ]);
      return { matchCode, chrono, homeScore, awayScore } as Partial<MatchUpdate>;
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
        if (!match) console.warn(`Unrecognized data: '${text}' (against ${regex})`);
        return match ? map(match) : undefined;
      } catch (error) {
        console.error("OCR error: " + error);
        return undefined;
      }
    };
  }

  private observeWindowUpdates(sourceId: string): Observable<Partial<MatchUpdate>> {
    return new Observable<Partial<CaptureData>>((sub) => {
      console.debug(`Creating capture window for '${sourceId}'`);
      const captureWindow = new BrowserWindow({
        show: false, webPreferences: {
          offscreen: true,
          preload: path.join(__dirname, "fdme-capture.js"),
          nodeIntegration: true
        }
      });
      const dataListener = (_: unknown, data: CaptureData) => sub.next(data);
      captureWindow.loadFile("assets/capture-window.html", { hash: sourceId });
      if (this.testMode) {
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
      mergeMap((dataUrl: CaptureData) => this.ocrMatcher(dataUrl)),
      tap(u => { if (this.testMode) console.debug(`OCR update: ${JSON.stringify(u)}`); }),
      startWith({} as Partial<MatchUpdate>),
      pairwise(),
      map(([prev, next]) => merge(prev, next)),
      distinctUntilChanged(isEqual),
      share()
    );
  }

  observeUpdates(): Observable<Partial<MatchUpdate>> {
    return defer(async () => {
      if (this.testMode) return ["@test"];
      const allSources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
      return allSources.filter(w => w.name == "Feuille de Table").map(w => w.id);
    }).pipe(
      repeat({ delay: 5000 }),
      switchScan((obs, sourceIds) => {
        // Create hidden capture window for new sources
        for (const sourceId of sourceIds) {
          if (obs.has(sourceId)) continue;
          console.debug(`Creating capture window for '${sourceId}'`);
          obs.set(sourceId, this.observeWindowUpdates(sourceId));
        }
        // Delete capture window for unavailable sources
        for (const sourceId of obs.keys()) {
          if (sourceIds.includes(sourceId)) continue;
          console.debug(`Closing capture window for '${sourceId}'`);
          obs.delete(sourceId);
        }
        return mergeObservables(...obs.values());
      }, new Map<string, Observable<Partial<MatchUpdate>>>()),
      share()
    );
  }

}