// Applies the saved theme before the app renders, so there is no light flash in dark mode.
// Same key and values as src/theme.tsx. A file, not an inline script, so it also works under
// a Content-Security-Policy that allows only same-origin scripts.
try {
  var theme = localStorage.getItem("app:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (e) {}
