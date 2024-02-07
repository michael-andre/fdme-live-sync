import { FirebaseApp, initializeApp } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { FieldValue, collection, doc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore/lite";
import { getFunctions, httpsCallable } from "firebase/functions";
import { MatchUpdate } from "./main";
import { EMPTY, Observable, Subscription, combineLatest, mergeMap, retry, scan, startWith, switchMap, throttleTime } from "rxjs";
import { merge } from "lodash";

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
    fdmeUpdates: Observable<MatchUpdate | null>,
    scorepadUpdates: Observable<MatchUpdate>,
    matchCode: Observable<string | null>
  ): Subscription {
    return matchCode.pipe(
      switchMap(code => {
        if (code == null) return EMPTY;
        const firebaseDoc = doc(collection(LiveSyncConsumer.firestore, "liveUpdates"), code);
        return combineLatest([fdmeUpdates, scorepadUpdates.pipe(startWith(null))])
          .pipe(
            scan((state, [fdmeUpdate, scorepadUpdate]) => {
              if (fdmeUpdate == null) {
                return {};
              } else if (state.homeScore && state.awayScore && state.chrono && scorepadUpdate?.awayScore == 0 && scorepadUpdate?.homeScore == 0) {
                // Prevent accidental reset
                return state;
              } else {
                return merge({}, state, fdmeUpdate, scorepadUpdate);
              }
            }, {} as MatchUpdate),
            throttleTime(15000, undefined, { leading: true, trailing: true }),
            mergeMap(async (update: MatchUpdate) => {
              try {
                const liveUpdate: LiveUpdate = {
                  chrono: update.chrono ?? null,
                  score: update?.homeScore != undefined && update?.awayScore != undefined
                    ? [update.homeScore, update.awayScore]
                    : null,
                  timestamp: serverTimestamp()
                }
                console.debug(`Server update for ${code}: ${JSON.stringify(liveUpdate)}`);
                await setDoc(firebaseDoc, liveUpdate);
              } catch (error) {
                console.log("Failed to send update: " + error);
              }
            }),
            retry({ delay: 30000 })
          );
      })
    ).subscribe({
      error: (e) => {
        console.error("Live sync consumer error");
        console.error(e);
      }
    });
  }

}

interface LiveUpdate {
  readonly score: [number, number] | null;
  readonly chrono: number | null;
  readonly timestamp: FieldValue;
}
