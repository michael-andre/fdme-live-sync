import { Timestamp } from "firebase/firestore";

export interface LiveUpdate {

  readonly score: [ number, number ] | null;
  readonly chrono: number | null;
  readonly timestamp: Timestamp;

}
