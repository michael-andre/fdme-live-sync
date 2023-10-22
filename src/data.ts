import { FieldValue } from "firebase/firestore/lite";

export interface LiveUpdate {

  readonly score: [ number, number ] | null;
  readonly chrono: number | null;
  readonly timestamp: FieldValue;

}
