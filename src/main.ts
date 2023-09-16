import { app, Tray, Menu, desktopCapturer, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { Observable, Subscription, defer, distinctUntilChanged, map, mergeMap, pairwise, repeat, startWith, throttleTime } from "rxjs";
import { createWorker } from "tesseract.js";
import { CaptureData } from "./capture";
import * as Tesseract from "tesseract.js";
import { initializeApp } from 'firebase/app';
import { getFirestore, collection } from 'firebase/firestore/lite';
import { DocumentReference, UpdateData, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { isEqual, merge } from "lodash";
import { LiveUpdate } from "./data";

let appTray: Tray | undefined;
let sourcesSubscription: Subscription | undefined;
let ocrSubscription: Subscription | undefined;

app.whenReady().then(() => {

  // Configure tray icon
  appTray = new Tray(path.join(__dirname, "../assets/icon.png"));
  const contextMenu = Menu.buildFromTemplate([
    { label: "Fermer", type: "normal", click: () => app.quit() }
  ]);
  appTray.setToolTip("Synchronisation FDME");
  appTray.setContextMenu(contextMenu);

  // Init OCR matchers
  const initOcrMatcher = <T>(whiteList: string, regex: RegExp, map: (match: RegExpMatchArray) => T) => {
    const scheduler = createWorker().then(async worker => {
      await worker.loadLanguage('eng');
      await worker.initialize('eng', Tesseract.OEM.TESSERACT_ONLY);
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
  const ocrChronoMatcher = initOcrMatcher('0123456789:-', /^(\d+):(\d+)$/, p => {
    const min = Number(p[1]);
    const sec = Number(p[2]);
    return min >= 0 && sec >= 0 ? min * 60 + sec : undefined;
  });
  const ocrScoreMatcher = initOcrMatcher('0123456789', /^(\d+)$/, p => Number(p[1]));
  const ocrCodeMatcher = initOcrMatcher('ABCDEFGHIJKLMNOPQRSTUVWXYZ', /^([A-Z]{7})$/, p => p[1]);

  const firebaseApp = initializeApp({
    apiKey: "AIzaSyBX4HCXjx5leejavOLGerFB2uqD8gTsV_M",
    authDomain: "uson-handball.firebaseapp.com",
    databaseURL: "https://uson-handball.firebaseio.com",
    projectId: "uson-handball",
    storageBucket: "uson-handball.appspot.com",
    messagingSenderId: "803331291747",
    appId: "1:803331291747:web:c9fb824d1a8c2f74439656"
  });
  const liveUpdates = collection(getFirestore(firebaseApp), "liveUpdates");

  // Init capture windows subscription
  const captureWindowCallbacks = new Map<string, () => void>();
  sourcesSubscription = defer(async () => {
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
              preload: path.join(__dirname, 'capture.js'),
              nodeIntegration: true
            }
          });
          captureWindow.webContents.on('console-message', (_, level, message) => {
            console.log(message);
          });      
          captureWindow.loadFile("assets/capture-window.html", { hash: sourceId });
          // captureWindow.webContents.openDevTools({ mode: "detach" });

          let firebaseDoc: DocumentReference | undefined;

          const ocrSubscription = new Observable<CaptureData>((sub) => {
            const listener = (_: unknown, data: CaptureData) => sub.next(data);
            ipcMain.on("capture-data:" + sourceId, listener);
            return () => ipcMain.off("capture-data:" + sourceId, listener);
          }).pipe(
            mergeMap(async (dataUrl: CaptureData) => {
              const [ chrono, homeScore, awayScore, matchCode ] = await Promise.all([
                ocrCodeMatcher(dataUrl.matchCode),
                ocrChronoMatcher(dataUrl.chrono),
                ocrScoreMatcher(dataUrl.homeScore),
                ocrScoreMatcher(dataUrl.awayScore)
              ]);
              return { matchCode, chrono, homeScore, awayScore } as Partial<MatchUpdate>;
            }),
            startWith({} as Partial<MatchUpdate>),
            pairwise(),
            map(([ prev, next ]) => merge(prev, next)),
            distinctUntilChanged(isEqual),
            throttleTime(30000),
            mergeMap(async (update: Partial<MatchUpdate>) => {
              console.debug(`Update: ${JSON.stringify(update)}`);
              if (!update.matchCode) return;
              try {
                firebaseDoc = firebaseDoc ?? doc(liveUpdates, update.matchCode);
                await setDoc(firebaseDoc, {
                  chrono: update.chrono ?? null,
                  score: update?.homeScore != undefined && update?.awayScore != undefined
                    ? [ update.homeScore, update.awayScore ]
                    : null,
                  timestamp: serverTimestamp()
                } as UpdateData<LiveUpdate>);  
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

app.on('before-quit', function () {
  sourcesSubscription?.unsubscribe();
  ocrSubscription?.unsubscribe();
  appTray?.destroy();
});

app.on('window-all-closed', () => {
  app.dock?.hide();
});

type MatchUpdate = {
  matchCode: string,
  homeScore: number,
  awayScore: number,
  chrono: number
};