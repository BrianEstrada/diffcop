// Lets callers in one at a time until one reports that the rest can go at once.
export class FirstAlone {
  #open = Promise.resolve(false);

  // Resolves when it's the caller's turn, with a function it must call: with
  // true once later callers may all go, or with false to pass its turn on.
  async enter() {
    const earlier = this.#open;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.#open = earlier.then((open) => {
      return open || promise;
    });
    await earlier;
    return resolve;
  }
}
