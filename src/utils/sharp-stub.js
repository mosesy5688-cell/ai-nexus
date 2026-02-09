export default {
    cache: () => { },
    toBuffer: () => ({ data: new Uint8Array(), info: {} }),
    resize: () => ({ rotate: () => ({ toFormat: () => ({ toBuffer: () => ({ data: new Uint8Array(), info: {} }) }) }) })
};
