export class KeyedMutex {
    #tails = new Map();
    async run(key, work) {
        const previous = this.#tails.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        this.#tails.set(key, tail);
        await previous;
        try {
            return await work();
        }
        finally {
            release();
            if (this.#tails.get(key) === tail)
                this.#tails.delete(key);
        }
    }
}
