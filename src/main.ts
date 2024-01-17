import { Menu, Tray, app } from "electron";
import * as log from "electron-log/main";
import { initializeApp } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { DocumentReference, collection, doc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore/lite";
import { getFunctions, httpsCallable } from "firebase/functions";
import * as path from "path";
import { Subscription, mergeMap, merge as mergeObservables, throttleTime } from "rxjs";
import { LiveUpdate } from "./data";
import { FDMEProvider } from "./fdme-provider";
import { ScorepadProvider } from "./scorepad-provider";

export type AppCheckTokenRequest = Readonly<{ appId: string; }>
export type AppCheckToken = Readonly<{ token: string, expiresInMillis: number }>;

let appTray: Tray | undefined;
let updatesSub: Subscription | undefined;

log.initialize({ preload: true });
Object.assign(console, log.functions);

app.whenReady().then(() => {

  const testMode = app.commandLine.getSwitchValue("mode") == "test";
  if (testMode) console.debug("Running in test mode");

  // Configure tray icon
  appTray = new Tray(path.join(__dirname, "..", "assets", "icon.png"));
  const contextMenu = Menu.buildFromTemplate([
    { label: "Fermer", type: "normal", click: () => app.quit() }
  ]);
  appTray.setToolTip("Synchronisation FDME");
  appTray.setContextMenu(contextMenu);

  const fdmeUpdates = new FDMEProvider(testMode).observeUpdates();
  const scorepadUpdates = new ScorepadProvider().observeUpdates();

  const updates = mergeObservables(fdmeUpdates, scorepadUpdates);

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
          const token = (await getAppCheckToken({ appId: firebaseAppId })).data;
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

  let firebaseDoc: DocumentReference | undefined;

  updatesSub = updates.pipe(
    throttleTime(30000),
    mergeMap(async (update: Partial<MatchUpdate>) => {
      if (!update.matchCode) return;
      try {
        firebaseDoc = firebaseDoc ?? doc(liveUpdates, update.matchCode);
        const liveUpdate: LiveUpdate = {
          chrono: update.chrono ?? null,
          score: update?.homeScore != undefined && update?.awayScore != undefined
            ? [update.homeScore, update.awayScore]
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
});

app.on("before-quit", function () {
  updatesSub?.unsubscribe();
  appTray?.destroy();
});

app.on("window-all-closed", () => {
  app.dock?.hide();
});

export type MatchUpdate = {
  matchCode: string,
  homeScore: number,
  awayScore: number,
  chrono: number
};