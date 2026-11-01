// Applies the saved (or system) colour theme before the page paints, so there is no dark/light flash.
// Only the theme name ("light" / "dark") is stored; no ledger data ever goes in localStorage.
(function(){
  var t = null;
  try{ t = localStorage.getItem("ledger_theme"); }catch(e){}
  if(t !== "light" && t !== "dark"){
    t = (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", t);
})();

// Safety net: if app.js did not run (wrong file uploaded, old copy cached, blocked), the sign-in button would
// say "Loading sign-in…" forever. Say what is wrong instead.
setTimeout(function(){
  if(window.__ledgerBooted) return;
  var label = document.getElementById("signInLabel"), err = document.getElementById("lockError");
  if(label) label.textContent = "App file problem";
  if(err) err.textContent = "⚠️ app.js did not load correctly (the file on the server is wrong or old). Upload app.js again, then refresh this page.";
}, 4000);
