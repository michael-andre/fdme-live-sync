import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import { isEqual, merge } from "lodash";
import * as path from "path";
import { EMPTY, Observable, defer, distinctUntilChanged, of, repeat, retry, scan, share, switchMap, tap, timer, withLatestFrom } from "rxjs";
import tesseract from "tesseract.js";
import { CaptureData } from "./fdme-capture";
import { MatchUpdate } from "./main";
import { exhaustMapLatest } from "./rx-utils";

const windowScanDelayMs = 5000;
const sourcesRetryDelayMs = 5000;
const captureWindowRetryDelayMs = 5000;

export function observeScoreSheetUpdates(testMode: boolean): Observable<MatchUpdate | null> {
  return (testMode ? of("@test") : observeScoreSheetWindowId()).pipe(
    switchMap(sourceId => {
      console.debug(`FDME window: ${sourceId}`);
      return sourceId ? observeScoreSheetCaptureData(sourceId).pipe(
        withLatestFrom(defer(() => initDataMatcher())),
        exhaustMapLatest(([captureData, ocrMatcher]) => ocrMatcher(captureData)),
        scan((state, update) => merge({}, state, update), {} as MatchUpdate),
        distinctUntilChanged(isEqual),
        tap(u => {
          console.debug(`FDME update: ${JSON.stringify(u)}`);
        }),
        share()
      ) : EMPTY;
    }),
    // Auto-retry on error
    retry({
      delay: (e) => {
        console.error(`FDME updates error: ${e}`);
        return timer(sourcesRetryDelayMs);
      }
    }),
    share()
  );
}

function observeScoreSheetWindowId(): Observable<string | null> {
  return defer(async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 }
    });
    return sources.filter(w => w.name == "Feuille de Table").at(0)?.id ?? null;
  }).pipe(
    repeat({ delay: windowScanDelayMs }),
    distinctUntilChanged()
  );
}

async function initDataMatcher(): Promise<(data: CaptureData) => Promise<MatchUpdate>> {
  const chronoMatcher = await createOcrMatcher("0123456789:-", /^(\d+):(\d+)$/, p => {
    const min = Number(p[1]);
    const sec = Number(p[2]);
    return min >= 0 && sec >= 0 ? min * 60 + sec : undefined;
  });
  const scoreMatcher = await createOcrMatcher("0123456789", /^(\d+)$/, p => Number(p[1]));
  return async (captureData: CaptureData) => {
    const [chrono, homeScore, awayScore] = await Promise.all([
      chronoMatcher(captureData.chrono),
      scoreMatcher(captureData.homeScore),
      scoreMatcher(captureData.awayScore)
    ]);
    return { chrono, homeScore, awayScore, chronoStarted: captureData.chronoStarted };
  };
}

async function createOcrMatcher<T>(whiteList: string, regex: RegExp, map: (match: RegExpMatchArray) => T) {
  const scheduler = await createOcrScheduler(whiteList);
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

async function createOcrScheduler(whiteList: string) {
  const worker = await new Promise<tesseract.Worker>((resolve, reject) =>
    tesseract.createWorker("eng", tesseract.OEM.TESSERACT_ONLY, {
      //langPath: "../assets",
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
  return scheduler;
}

function observeScoreSheetCaptureData(sourceId: string): Observable<CaptureData> {
  return new Observable<CaptureData>((sub) => {
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
    captureWindow.webContents.on("console-message", (_event, _level, message) => {
      console.debug(message);
    });
    const ipcChannel = `capture-data:${sourceId}`;
    ipcMain.on(ipcChannel, dataListener);
    captureWindow.on("closed", () => sub.complete());
    return () => {
      ipcMain.off(ipcChannel, dataListener);
      captureWindow.close();
    };
  }).pipe(
    repeat({ delay: captureWindowRetryDelayMs }),
    // Auto-retry on error
    retry({
      delay: (e) => {
        console.error(`FDME capture window error: ${e}`);
        return timer(captureWindowRetryDelayMs);
      }
    }),
    share()
  );
}
