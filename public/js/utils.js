export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function throttle(fn, wait = 200) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const now = performance.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = performance.now();
        fn(...lastArgs);
      }, wait - (now - last));
    }
  };
}

export function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  if (raw.startsWith("/r/")) {
    return { view: "room", code: raw.slice(3).split(/[/?]/)[0].toUpperCase() };
  }
  return { view: "home" };
}

export function navigate(path) {
  if (location.hash === path) return;
  location.hash = path;
}
