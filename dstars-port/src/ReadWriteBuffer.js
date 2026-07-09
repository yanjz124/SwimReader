// Ported 1:1 from _source/ReadWriteBuffer.cs
// namespace DGScope
// byte[] -> Uint8Array; Array.Copy -> TypedArray.set; C# indexer this[i] -> Item(i);
// IEnumerable<byte> Bytes { yield return } -> getter returning a generator iterator.

export class ReadWriteBuffer {
    #_buffer;         // readonly byte[]
    #_startIndex = 0; // int
    #_endIndex = 0;   // int

    constructor(capacity) {
        this.#_buffer = new Uint8Array(capacity); // new byte[capacity]
    }

    get Count() { // int
        if (this.#_endIndex > this.#_startIndex)
            return this.#_endIndex - this.#_startIndex;
        if (this.#_endIndex < this.#_startIndex)
            return (this.#_buffer.length - this.#_startIndex) + this.#_endIndex;
        return 0;
    }

    Write(data) { // void Write(byte[] data)
        if (this.Count + data.length > this.#_buffer.length)
            throw new Error("buffer overflow");
        if (this.#_endIndex + data.length >= this.#_buffer.length) {
            let endLen = this.#_buffer.length - this.#_endIndex;
            let remainingLen = data.length - endLen;

            this.#_buffer.set(data.subarray(0, endLen), this.#_endIndex);              // Array.Copy(data, 0, _buffer, _endIndex, endLen)
            this.#_buffer.set(data.subarray(endLen, endLen + remainingLen), 0);        // Array.Copy(data, endLen, _buffer, 0, remainingLen)
            this.#_endIndex = remainingLen;
        }
        else {
            this.#_buffer.set(data.subarray(0, data.length), this.#_endIndex);         // Array.Copy(data, 0, _buffer, _endIndex, data.length)
            this.#_endIndex += data.length;
        }
    }

    Read(len, keepData = false) { // byte[] Read(int len, bool keepData = false)
        if (len > this.Count)
            throw new Error("not enough data in buffer");
        let result = new Uint8Array(len);
        if (this.#_startIndex + len < this.#_buffer.length) {
            result.set(this.#_buffer.subarray(this.#_startIndex, this.#_startIndex + len), 0);
            if (!keepData)
                this.#_startIndex += len;
            return result;
        }
        else {
            let endLen = this.#_buffer.length - this.#_startIndex;
            let remainingLen = len - endLen;
            result.set(this.#_buffer.subarray(this.#_startIndex, this.#_startIndex + endLen), 0);
            result.set(this.#_buffer.subarray(0, remainingLen), endLen);
            if (!keepData)
                this.#_startIndex = remainingLen;
            return result;
        }
    }

    // public byte this[int index]  (C# indexer) -> method Item(index)
    Item(index) { // byte
        if (index >= this.Count)
            throw new Error("ArgumentOutOfRangeException");
        return this.#_buffer[(this.#_startIndex + index) % this.#_buffer.length];
    }

    // public IEnumerable<byte> Bytes { get { for(...) yield return ...; } }
    get Bytes() {
        const self = this;
        return (function* () {
            for (let i = 0; i < self.Count; i++)
                yield self.#_buffer[(self.#_startIndex + i) % self.#_buffer.length];
        })();
    }
}
