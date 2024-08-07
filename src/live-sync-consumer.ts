import { FirebaseApp, initializeApp } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { FieldValue, collection, doc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore/lite";
import { getFunctions, httpsCallable } from "firebase/functions";
import { merge } from "lodash";
import { Observable, Subscription, combineLatest, mergeMap, retry, scan, startWith, throttleTime, timer } from "rxjs";
import { MatchUpdate } from "./main";

const errorRetryDelayMs = 30000;

type AppCheckTokenRequest = Readonly<{ appId: string; }>
type AppCheckToken = Readonly<{ token: string, expiresInMillis: number }>;

export class LiveSyncConsumer {

  private static readonly firestore = getFirestore(this.initFirebaseApp());

  private static initFirebaseApp(): FirebaseApp {
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
    const app = initializeApp(firebaseOptions);
    initializeAppCheck(app, {
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
    return app;
  }

  subscribe(
    scoreSheetUpdates: Observable<MatchUpdate | null>,
    scorepadUpdates: Observable<MatchUpdate>
  ): Subscription {
    return combineLatest([scoreSheetUpdates, scorepadUpdates.pipe(startWith(null))])
      .pipe(
        scan((state, [scoreSheetUpdate, scorepadUpdate]) => {
          if (!scoreSheetUpdate?.matchCode) {
            return {};
          } else if (
            state.homeScore && state.awayScore && state.chrono
            && scorepadUpdate?.awayScore == 0 && scorepadUpdate?.homeScore == 0
          ) {
            // Prevent accidental reset
            return state;
          } else {
            return merge({}, state, scoreSheetUpdate, scorepadUpdate);
          }
        }, {} as MatchUpdate),
        throttleTime(15000, undefined, { leading: true, trailing: true }),
        mergeMap(async (update: MatchUpdate) => {
          try {
            if (!update.matchCode) return;
            const liveUpdate: LiveUpdate = {
              chrono: update.chrono ?? null,
              score: update?.homeScore != undefined && update?.awayScore != undefined
                ? [update.homeScore, update.awayScore]
                : null,
              timestamp: serverTimestamp()
            }
            console.debug(`Server update for ${update.matchCode}: ${JSON.stringify(liveUpdate)}`);
            const firebaseDoc = doc(collection(LiveSyncConsumer.firestore, "liveUpdates"), update.matchCode);
            await setDoc(firebaseDoc, liveUpdate);
          } catch (error) {
            console.log("Failed to send update: " + error);
          }
        }),
        // Auto-retry on error
        retry({
          delay: (e) => {
            console.error(`Live reporting error: ${e}`);
            return timer(errorRetryDelayMs);
          }
        })
      ).subscribe();
  }

}

interface LiveUpdate {
  readonly score: [number, number] | null;
  readonly chrono: number | null;
  readonly timestamp: FieldValue;
}
