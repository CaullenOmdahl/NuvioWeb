import { Router } from "./router.js";

export const MouseEngine = {
  active: false,

  init() {
    document.addEventListener("mousemove", this.onMouseMove.bind(this), true);
    document.addEventListener("click", this.onClick.bind(this), true);
  },

  onMouseMove(event) {
    const target = event.target?.closest?.(".focusable");
    if (!target) {
      return;
    }

    this.active = true;
    document.documentElement.classList.add("mouse-active");

    const currentFocused = target.closest("[style]")?.querySelector(".focusable.focused")
      || document.querySelector(".focusable.focused");

    if (currentFocused === target) {
      return;
    }

    if (currentFocused) {
      currentFocused.classList.remove("focused");
    }
    target.classList.add("focused");
    target.focus({ preventScroll: true });
  },

  onClick(event) {
    const target = event.target?.closest?.(".focusable");
    if (!target) {
      return;
    }

    this.active = true;
    document.documentElement.classList.add("mouse-active");

    const currentFocused = document.querySelector(".focusable.focused");
    if (currentFocused && currentFocused !== target) {
      currentFocused.classList.remove("focused");
    }
    target.classList.add("focused");
    target.focus({ preventScroll: true });
  }
};
