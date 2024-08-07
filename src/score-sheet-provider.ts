import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import * as fs from "fs";
import { isEqual, merge } from "lodash";
import * as os from "os";
import * as path from "path";
import ReverseReader from "readline-reverse";
import {
  BehaviorSubject, EMPTY, NEVER, Observable, defer, distinctUntilChanged, of, repeat, retry, scan, share, shareReplay,
  startWith, switchMap, tap, timer, withLatestFrom
} from "rxjs";
import tesseract from "tesseract.js";
import { MatchUpdate } from "./main";
import { exhaustMapLatest } from "./rx-utils";
import { CaptureData } from "./score-sheet-capture";

export class ScoreSheetSource {

  private readonly logFileRetryDelayMs = 10000;
  private readonly captureWindowsScanDelayMs = 5000;
  private readonly captureWindowRetryDelayMs = 5000;
  private readonly processingErrorRetryDelayMs = 5000;

  readonly state = new BehaviorSubject<"off" | "ready" | "connected" | "error">("off");

  constructor(private testMode: boolean) { }

  private activeMatchCode: Observable<string | null> = this.testMode
    ? of("FTESTxx")
    : defer(() => {
      const publicDir = os.platform() == "win32" ? process.env["PUBLIC"] : null;
      if (!publicDir) {
        console.warn("Not running Windows, match code detection disabled");
        this.state.next("off");
        return NEVER;
      }
      const logFilePath = `${publicDir}\\Documents\\SaisieFeuilleGesthand\\LogFeuille.log`;
      if (!fs.existsSync(logFilePath)) {
        throw Error("FDME log file not found");
      }
      return this.observeLogFileChanges(logFilePath);
    }).pipe(
      exhaustMapLatest(path => this.parseActiveMatchCode(path)),
      distinctUntilChanged(),
      tap(code => console.debug(`Match code: ${code}`)),
      // Auto-retry on error
      retry({
        delay: (e) => {
          console.error(`FDME log file watch error: ${e}`);
          this.state.next("error");
          return timer(this.logFileRetryDelayMs);
        }
      }),
      shareReplay({ refCount: true, bufferSize: 1 })
    );

  private readonly captureWindowId: Observable<string | null> =
    defer(async () => {
      this.state.next("ready");
      if (this.testMode) return "@test";
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 }
      });
      return sources.filter(w => w.name == "Feuille de Table").at(0)?.id ?? null;
    }).pipe(
      repeat({ delay: this.captureWindowsScanDelayMs }),
      distinctUntilChanged()
    );

  readonly updates: Observable<MatchUpdate | null> =
    this.activeMatchCode.pipe(
      switchMap(matchCode => matchCode ? this.captureWindowId.pipe(
        switchMap(sourceId => {
          console.debug(`FDME window: ${sourceId}`);
          if (sourceId) {
            return this.createCaptureWindow(sourceId).pipe(
              withLatestFrom(defer(() => this.initDataMatcher())),
              exhaustMapLatest(([captureData, ocrMatcher]) => ocrMatcher(captureData)),
              scan((state, update) => merge({}, state, update), { matchCode } as MatchUpdate),
              distinctUntilChanged<MatchUpdate>(isEqual),
              tap(u => {
                console.debug(`FDME update: ${JSON.stringify(u)}`);
              }),
              share()
            );
          } else {
            this.state.next("off");
            return EMPTY;
          }
        })
      ) : of(null)),
      // Auto-retry on error
      retry({
        delay: (e) => {
          console.error(`FDME updates error: ${e}`);
          this.state.next("error");
          return timer(this.processingErrorRetryDelayMs);
        }
      }),
      share()
    );

  private createCaptureWindow(sourceId: string): Observable<CaptureData> {
    return new Observable<CaptureData>((sub) => {
      console.debug(`Creating capture window for '${sourceId}'`);
      const captureWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          preload: path.join(__dirname, "score-sheet-capture.js"),
          nodeIntegration: true
        }
      });
      const dataListener = (_: unknown, data: CaptureData) => sub.next(data);
      captureWindow.loadFile("assets/window.html", { hash: sourceId });
      captureWindow.webContents.on("console-message", (_event, _level, message) => {
        console.debug(message);
      });
      const ipcChannel = `capture-data:${sourceId}`;
      ipcMain.on(ipcChannel, dataListener);
      captureWindow.on("closed", () => sub.complete());
      this.state.next("connected");
      return () => {
        ipcMain.off(ipcChannel, dataListener);
        captureWindow.close();
      };
    }).pipe(
      // Auto-reopen on close
      repeat({ delay: this.captureWindowRetryDelayMs }),
      // Auto-retry on error
      retry({
        delay: (e) => {
          console.error(`FDME capture window error: ${e}`);
          this.state.next("error");
          return timer(this.captureWindowRetryDelayMs);
        }
      }),
      share()
    );
  }

  private async initDataMatcher(): Promise<(data: CaptureData) => Promise<MatchUpdate>> {
    const chronoMatcher = await this.createOcrMatcher("0123456789:-", /^(\d+):(\d+)$/, p => {
      const min = Number(p[1]);
      const sec = Number(p[2]);
      return min >= 0 && sec >= 0 ? min * 60 + sec : undefined;
    });
    const scoreMatcher = await this.createOcrMatcher("0123456789", /^(\d+)$/, p => Number(p[1]));
    return async (captureData: CaptureData) => {
      const [chrono, homeScore, awayScore] = await Promise.all([
        chronoMatcher(captureData.chrono),
        scoreMatcher(captureData.homeScore),
        scoreMatcher(captureData.awayScore)
      ]);
      return { chrono, homeScore, awayScore, chronoStarted: captureData.chronoStarted };
    };
  }

  private async createOcrMatcher<T>(whiteList: string, regex: RegExp, map: (match: RegExpMatchArray) => T) {
    const worker = await new Promise<tesseract.Worker>((resolve, reject) =>
      tesseract.createWorker("eng", tesseract.OEM.TESSERACT_ONLY, {
        cachePath: path.join(__dirname, "..", "assets", "ocr-data"),
        cacheMethod: "read",
        gzip: false,
        errorHandler: reject
      }).then(resolve));
    await worker.setParameters({
      tessedit_char_whitelist: whiteList,
      tessedit_pageseg_mode: tesseract.PSM.SINGLE_WORD
    });
    const scheduler = tesseract.createScheduler();
    scheduler.addWorker(worker);
    return async (input: Tesseract.ImageLike | undefined) => {
      if (!input) return undefined;
      try {
        const result = scheduler.addJob("recognize", input);
        const text = (await result).data.text.trim();
        const match = text.match(regex);
        if (!match) {
          console.warn(`Unrecognized data: '${text}' (against ${regex})`);
        }
        return match ? map(match) : undefined;
      } catch (error) {
        console.error("OCR error: " + error);
        return undefined;
      }
    };
  }

  private observeLogFileChanges(path: string): Observable<string> {
    return new Observable<string>(sub => {
      const watcher = fs.watch(path, { encoding: "buffer" }, e => {
        if (e == "change") sub.next(path);
      });
      return () => watcher.close();
    }).pipe(
      startWith(path)
    );
  }

  private async parseActiveMatchCode(logFile: string): Promise<string | null> {
    const reader = new ReverseReader();
    try {
      await reader.open(logFile);
      const lines = await reader.read(10);
      const pattern = new RegExp("ouverture feuille table coderenc=([A-Z]{7})");
      for (const line of lines.reverse()) {
        const match = line.match(pattern);
        if (match) return match[1];
      }
    } catch (e) {
      console.warn(`Failed to process log file: ${e}`);
    } finally {
      await reader.close();
    }
    return null;
  }

}