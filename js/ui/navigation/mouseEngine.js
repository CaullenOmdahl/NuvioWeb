import { Router } from "./router.js";

const CLICK_TARGET_SELECTOR = ".focusable, [data-mouse-action]";

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
    if (Number(event?.button || 0) !== 0 || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) {
      return;
    }

    const target = event.target?.closest?.(CLICK_TARGET_SELECTOR);
    if (!target) {
      return;
    }

    this.active = true;
    document.documentElement.classList.add("mouse-active");

    const focusTarget = target.matches?.(".focusable") ? target : target.closest?.(".focusable");
    if (focusTarget) {
      const currentFocused = document.querySelector(".focusable.focused");
      if (currentFocused && currentFocused !== focusTarget) {
        currentFocused.classList.remove("focused");
      }
      focusTarget.classList.add("focused");
      focusTarget.focus({ preventScroll: true });
    }

    const currentScreen = Router.getCurrentScreen();
    if (currentScreen?.onMouseActivate?.(target, event)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
    }
  }
};
