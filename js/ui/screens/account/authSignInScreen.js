import { Router } from "../../navigation/router.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { LocalStore } from "../../../core/storage/localStore.js";
import { I18n } from "../../../i18n/index.js";

function t(key, fallback) {
  return I18n.t(key, {}, { fallback: fallback || key });
}

export const AuthSignInScreen = {

  async mount() {
    this.container = document.getElementById("account");
    this.isMounted = true;
    this.isSubmitting = false;
    this.errorMessage = "";
    ScreenUtils.show(this.container);
    this.render();
  },

  render() {
    this.container.innerHTML = `
      <div class="auth-email-layout">
        <section class="auth-email-brand-panel">
          <div class="qr-brand-lockup">
            <img src="assets/brand/app_logo_wordmark.png" class="qr-logo" alt="Nuvio" />
          </div>
          <div class="qr-copy-block">
            <h1 class="qr-title">${t("auth.email.title", "Sign In")}</h1>
            <p class="qr-description">${t("auth.email.description", "Sign in with your email and password to sync your library across devices.")}</p>
          </div>
        </section>

        <section class="auth-email-card-panel">
          <div class="auth-email-card">
            <header class="qr-card-header">
              <h2 class="qr-card-title">${t("auth.email.cardTitle", "Email Login")}</h2>
              <p class="qr-card-subtitle">${t("auth.email.cardSubtitle", "Enter your credentials below")}</p>
            </header>

            <form id="email-login-form" class="auth-email-form" autocomplete="on">
              <div class="auth-email-field">
                <label class="auth-email-label" for="email-input">${t("auth.email.emailLabel", "Email")}</label>
                <input
                  id="email-input"
                  class="auth-email-input focusable"
                  type="email"
                  autocomplete="email"
                  autocapitalize="off"
                  spellcheck="false"
                  placeholder="${t("auth.email.emailPlaceholder", "you@example.com")}"
                  data-action="emailInput"
                />
              </div>
              <div class="auth-email-field">
                <label class="auth-email-label" for="password-input">${t("auth.email.passwordLabel", "Password")}</label>
                <input
                  id="password-input"
                  class="auth-email-input focusable"
                  type="password"
                  autocomplete="current-password"
                  placeholder="${t("auth.email.passwordPlaceholder", "Enter your password")}"
                  data-action="passwordInput"
                />
              </div>
              <div id="email-login-error" class="auth-email-error">${this.errorMessage || ""}</div>
            </form>

            <div class="auth-email-actions">
              <button type="button" id="email-submit-btn" class="auth-email-primary-btn focusable" data-action="submit"${this.isSubmitting ? " disabled" : ""}>
                ${this.isSubmitting ? t("auth.email.signingIn", "Signing in...") : t("auth.email.signIn", "Sign In")}
              </button>
              <button type="button" id="email-qr-btn" class="auth-email-secondary-btn focusable" data-action="qrLogin">
                ${t("auth.email.useQrCode", "Use QR Code")}
              </button>
              <button type="button" id="email-back-btn" class="auth-email-secondary-btn focusable" data-action="back">
                ${t("auth.email.continueAsGuest", "Continue as Guest")}
              </button>
            </div>
          </div>
        </section>
      </div>
    `;

    this.bindEvents();
    ScreenUtils.indexFocusables(this.container);
    ScreenUtils.setInitialFocus(this.container);

    // Auto-focus the email input
    const emailInput = this.container.querySelector("#email-input");
    if (emailInput) {
      emailInput.focus();
      emailInput.classList.add("focused");
    }
  },

  bindEvents() {
    const form = this.container.querySelector("#email-login-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this.handleSubmit();
      });
    }

    // Focus ring styling for inputs
    this.container.querySelectorAll("input.focusable").forEach((input) => {
      input.addEventListener("focus", () => {
        input.style.borderColor = "var(--focus-color, #6366f1)";
        input.style.boxShadow = "0 0 0 2px rgb(var(--focus-color-rgb) / 0.8)";
      });
      input.addEventListener("blur", () => {
        input.style.borderColor = "var(--border-color, #333)";
        input.style.boxShadow = "none";
      });
    });

    // Enter on password field submits
    const passwordInput = this.container.querySelector("#password-input");
    if (passwordInput) {
      passwordInput.addEventListener("keydown", (e) => {
        if (e.keyCode === 13) {
          e.preventDefault();
          this.handleSubmit();
        }
      });
    }

    // Button clicks
    this.container.querySelector("#email-submit-btn")?.addEventListener("click", () => this.handleSubmit());
    this.container.querySelector("#email-qr-btn")?.addEventListener("click", () => Router.navigate("authQrSignIn"));
    this.container.querySelector("#email-back-btn")?.addEventListener("click", () => this.handleGuestContinue());
  },

  async handleSubmit() {
    if (this.isSubmitting) return;

    const emailInput = this.container?.querySelector("#email-input");
    const passwordInput = this.container?.querySelector("#password-input");
    const email = String(emailInput?.value || "").trim();
    const password = String(passwordInput?.value || "");

    if (!email) {
      this.showError(t("auth.email.errorEmailRequired", "Please enter your email address"));
      emailInput?.focus();
      return;
    }

    if (!password) {
      this.showError(t("auth.email.errorPasswordRequired", "Please enter your password"));
      passwordInput?.focus();
      return;
    }

    this.isSubmitting = true;
    this.showError("");
    this.updateSubmitButton();

    try {
      await AuthManager.signInWithEmail(email, password);
      if (!this.isMounted) return;
      LocalStore.remove("skipAuthQrGate");
      LocalStore.set("hasSeenAuthQrOnFirstLaunch", true);
      Router.navigate("profileSelection");
    } catch (error) {
      if (!this.isMounted) return;
      const message = String(error?.message || "Login failed");
      if (error?.status === 400) {
        this.showError(t("auth.email.errorInvalidCredentials", "Invalid email or password"));
      } else if (message.toLowerCase().includes("network") || message.toLowerCase().includes("fetch")) {
        this.showError(t("auth.email.errorNetwork", "Network error. Check your connection."));
      } else {
        this.showError(message);
      }
    } finally {
      if (this.isMounted) {
        this.isSubmitting = false;
        this.updateSubmitButton();
      }
    }
  },

  handleGuestContinue() {
    LocalStore.set("hasSeenAuthQrOnFirstLaunch", true);
    LocalStore.set("skipAuthQrGate", true);
    Router.navigate("home", {}, { replaceHistory: true, skipStackPush: true });
  },

  showError(message) {
    this.errorMessage = message;
    const errorEl = this.container?.querySelector("#email-login-error");
    if (errorEl) {
      errorEl.textContent = message;
    }
  },

  updateSubmitButton() {
    const btn = this.container?.querySelector("#email-submit-btn");
    if (btn) {
      btn.disabled = this.isSubmitting;
      btn.textContent = this.isSubmitting
        ? t("auth.email.signingIn", "Signing in...")
        : t("auth.email.signIn", "Sign In");
    }
  },

  onKeyDown(event) {
    // Let inputs handle their own keypresses
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === "INPUT")) {
      // Tab between email and password
      if (event.keyCode === 40) { // Down arrow
        event.preventDefault();
        const emailInput = this.container?.querySelector("#email-input");
        const passwordInput = this.container?.querySelector("#password-input");
        if (activeEl === emailInput && passwordInput) {
          passwordInput.focus();
          return;
        }
        if (activeEl === passwordInput) {
          // Move focus to submit button
          const submitBtn = this.container?.querySelector("#email-submit-btn");
          if (submitBtn) {
            activeEl.blur();
            ScreenUtils.indexFocusables(this.container);
            submitBtn.classList.add("focused");
            submitBtn.focus();
          }
          return;
        }
      }
      if (event.keyCode === 38) { // Up arrow
        event.preventDefault();
        const emailInput = this.container?.querySelector("#email-input");
        const passwordInput = this.container?.querySelector("#password-input");
        if (activeEl === passwordInput && emailInput) {
          emailInput.focus();
          return;
        }
      }
      return;
    }

    if (ScreenUtils.handleDpadNavigation(event, this.container)) {
      return;
    }

    if (event.keyCode === 13) {
      const current = this.container?.querySelector(".focusable.focused");
      if (!current) return;
      const action = current.dataset.action;
      if (action === "submit") {
        this.handleSubmit();
      } else if (action === "qrLogin") {
        Router.navigate("authQrSignIn");
      } else if (action === "back") {
        this.handleGuestContinue();
      } else if (action === "emailInput" || action === "passwordInput") {
        current.focus();
      }
    }
  },

  cleanup() {
    this.isMounted = false;
    this.isSubmitting = false;
    this.errorMessage = "";
    ScreenUtils.hide(this.container);
  }

};
