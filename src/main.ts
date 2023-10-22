import { app, Tray, Menu, desktopCapturer, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { Observable, Subscription, defer, distinctUntilChanged, map, mergeMap, pairwise, repeat, startWith, tap, throttleTime } from "rxjs";
import { createWorker } from "tesseract.js";
import { CaptureData } from "./capture";
import * as Tesseract from "tesseract.js";
import { initializeApp } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getFirestore, collection, doc, DocumentReference, serverTimestamp, setDoc } from "firebase/firestore/lite";
import { isEqual, merge } from "lodash";
import { LiveUpdate } from "./data";

export type AppCheckTokenRequest = Readonly<{ appId: string; }>
export type AppCheckToken = Readonly<{ token: string, expiresInMillis: number }>;

let appTray: Tray | undefined;
let sourcesSubscription: Subscription | undefined;
let ocrSubscription: Subscription | undefined;

app.whenReady().then(() => {

  const testMode = app.commandLine.getSwitchValue("mode") == "test";
  if (testMode) console.debug("Running in test mode");

  // Configure tray icon
  appTray = new Tray(path.join(__dirname, "../assets/icon.png"));
  const contextMenu = Menu.buildFromTemplate([
    { label: "Fermer", type: "normal", click: () => app.quit() }
  ]);
  appTray.setToolTip("Synchronisation FDME");
  appTray.setContextMenu(contextMenu);

  // Init OCR matchers
  const initOcrMatcher = <T>(whiteList: string, regex: RegExp, map: (match: RegExpMatchArray) => T) => {
    const scheduler = createWorker("eng", Tesseract.OEM.TESSERACT_ONLY).then(async worker => {
      await worker.setParameters({
        tessedit_char_whitelist: whiteList,
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD
      });
      const scheduler = Tesseract.createScheduler();
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
  };
  const ocrChronoMatcher = initOcrMatcher("0123456789:-", /^(\d+):(\d+)$/, p => {
    const min = Number(p[1]);
    const sec = Number(p[2]);
    return min >= 0 && sec >= 0 ? min * 60 + sec : undefined;
  });
  const ocrScoreMatcher = initOcrMatcher("0123456789", /^(\d+)$/, p => Number(p[1]));
  const ocrCodeMatcher = initOcrMatcher("ABCDEFGHIJKLMNOPQRSTUVWXYZ", testMode ? /^(FTESTXX)$/ : /^([A-Z]{7})$/, p => p[1]);

  const firebaseAppId = "1:803331291747:web:c9fb824d1a8c2f74439656";
  const firebaseOptions = {
    apiKey: "AIzaSyBX4HCXjx5leejavOLGerFB2uqD8gTsV_M",
    authDomain: "uson-handball.firebaseapp.com",
    databaseURL: "https://uson-handball.firebaseio.com",
    projectId: "uson-handball",
    storageBucket: "uson-handball.appspot.com",
    messagingSenderId: "803331291747",
    appId: firebaseAppId
  };
  const firebaseApp = initializeApp(firebaseOptions);
  initializeAppCheck(firebaseApp, {
    provider: new CustomProvider({
      getToken: async () => {
        try {
          const getAppCheckToken = httpsCallable<AppCheckTokenRequest, AppCheckToken>(
            getFunctions(initializeApp(firebaseOptions, "appCheck"), "europe-west3"),
            "iam-appCheckToken"
          );
          console.log("Fetching App Check token");
          const token  = (await getAppCheckToken({ appId: firebaseAppId })).data;
          return {
            token: token.token,
            expireTimeMillis: Date.now() + token.expiresInMillis
          }  
        } catch (error) {
          console.error("AppCheck error: " + error);
          throw Error("AppCheck error");
        }
      },
    }),
    isTokenAutoRefreshEnabled: true    
  });
  const liveUpdates = collection(getFirestore(firebaseApp), "liveUpdates");

  // Init capture windows subscription
  const captureWindowCallbacks = new Map<string, () => void>();
  sourcesSubscription = defer(async () => {
    if (testMode) return [ "@test" ];
    const allSources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
    return allSources.filter(w => w.name == "Feuille de Table").map(w => w.id);
  }).pipe(
    repeat({ delay: 5000 }),
  ).subscribe({
    next: (sourceIds) => {
      try {

        // Create hidden capture window for new sources
        for (const sourceId of sourceIds) {
          if (captureWindowCallbacks.has(sourceId)) continue;

          appTray?.displayBalloon({
            title: "Sychronisation FDME en cours",
            content: "Merci de configurer correctement le chronomètre."
          });

          console.debug(`Creating capture window for '${sourceId}'`);
          const captureWindow = new BrowserWindow({
            show: false, webPreferences: {
              offscreen: true,
              preload: path.join(__dirname, "capture.js"),
              nodeIntegration: true
            }
          });
          if (testMode) {
            captureWindow.webContents.on("console-message", (_event, _level, message) => {
              console.debug(message);
            });  
          }
          captureWindow.loadFile("assets/capture-window.html", { hash: sourceId });
          // captureWindow.webContents.openDevTools({ mode: "detach" });

          let firebaseDoc: DocumentReference | undefined;

          const ocrSubscription = new Observable<CaptureData>((sub) => {
            const listener = (_: unknown, data: CaptureData) => sub.next(data);
            ipcMain.on("capture-data:" + sourceId, listener);
            return () => ipcMain.off("capture-data:" + sourceId, listener);
          }).pipe(
            mergeMap(async (dataUrl: CaptureData) => {
              const [ matchCode, chrono, homeScore, awayScore ] = await Promise.all([
                ocrCodeMatcher(dataUrl.matchCode),
                ocrChronoMatcher(dataUrl.chrono),
                ocrScoreMatcher(dataUrl.homeScore),
                ocrScoreMatcher(dataUrl.awayScore)
              ]);
              return { matchCode, chrono, homeScore, awayScore } as Partial<MatchUpdate>;
            }),
            tap(u => { if (testMode) console.debug(`OCR update: ${JSON.stringify(u)}`); }),
            startWith({} as Partial<MatchUpdate>),
            pairwise(),
            map(([ prev, next ]) => merge(prev, next)),
            distinctUntilChanged(isEqual),
            throttleTime(30000),
            mergeMap(async (update: Partial<MatchUpdate>) => {
              if (!update.matchCode) return;
              try {
                firebaseDoc = firebaseDoc ?? doc(liveUpdates, update.matchCode);
                const liveUpdate: LiveUpdate = {
                  chrono: update.chrono ?? null,
                  score: update?.homeScore != undefined && update?.awayScore != undefined
                    ? [ update.homeScore, update.awayScore ]
                    : null,
                  timestamp: serverTimestamp()
                }
                console.debug(`Server update: ${JSON.stringify(liveUpdate)}`);
                await setDoc(firebaseDoc, liveUpdate);
              } catch (error) {
                console.log("Failed to send update: " + error);
              }
            })
          ).subscribe();

          captureWindowCallbacks.set(sourceId, () => {
            ocrSubscription?.unsubscribe();
            captureWindow.close();
          });
        }

        // Delete capture window for unavailable sources
        for (const [ sourceId, callback ] of captureWindowCallbacks.entries()) {
          if (sourceIds.includes(sourceId)) continue;
          console.debug(`Closing capture window for '${sourceId}'`);
          callback();
          captureWindowCallbacks.delete(sourceId);
        }

      } catch (error) {
        console.error("Source windows error: " + error);
      }
    }
  });
  
});

app.on("before-quit", function () {
  sourcesSubscription?.unsubscribe();
  ocrSubscription?.unsubscribe();
  appTray?.destroy();
});

app.on("window-all-closed", () => {
  app.dock?.hide();
});

type MatchUpdate = {
  matchCode: string,
  homeScore: number,
  awayScore: number,
  chrono: number
};