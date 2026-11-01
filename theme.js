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
