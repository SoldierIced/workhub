// Test stand-in for oneshot.mjs that never answers: the caller kills it (abort or timeout).
setInterval(() => undefined, 1000)
