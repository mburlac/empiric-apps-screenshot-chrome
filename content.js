// Guard against multiple injections
if (!window.__fullPageCapture) {
  window.__fullPageCapture = {
    hiddenElements: [],

    measure() {
      // Take the max of all possible height measurements
      const scrollHeight = Math.max(
        document.body.scrollHeight || 0,
        document.body.offsetHeight || 0,
        document.documentElement.scrollHeight || 0,
        document.documentElement.offsetHeight || 0,
        document.documentElement.clientHeight || 0
      );
      return {
        scrollHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    },

    hideFixed() {
      this.hiddenElements = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          this.hiddenElements.push({ el, prev: el.style.display });
          el.style.display = 'none';
        }
      }
    },

    restoreFixed() {
      for (const { el, prev } of this.hiddenElements) {
        el.style.display = prev;
      }
      this.hiddenElements = [];
    },
  };
}
