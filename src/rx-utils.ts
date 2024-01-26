import { EMPTY, Observable, ObservableInput, ObservedValueOf, concat, defer, from, mergeMap, tap } from "rxjs";

export function exhaustMapLatest<T, O extends ObservableInput<unknown>>(
  project: (value: T) => O
) {
  return (source: Observable<T>) => defer(() => {
    let latestValue: T;
    let hasLatestValue = false;
    let isExhausting = false;
    const next = (value: T): Observable<ObservedValueOf<O>> => defer(() => {
      if (isExhausting) {
        latestValue = value;
        hasLatestValue = true;
        return EMPTY;
      }
      hasLatestValue = false;
      isExhausting = true;
      return from(project(value)).pipe(
        tap({ complete: () => isExhausting = false }),
        s => concat(s, defer(() => hasLatestValue ?
          next(latestValue) :
          EMPTY
        ))
      );
    });
    return from(source).pipe(mergeMap(next));
  });
}