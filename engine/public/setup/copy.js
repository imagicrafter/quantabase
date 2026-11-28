/* Copy buttons: a button with data-copy puts that text on the clipboard.
   No data from the page is read beyond the button's own attribute. Without
   this script the text is still on the page to select by hand. */
(function () {
  "use strict";
  document.addEventListener("click", function (event) {
    var button = event.target instanceof Element ? event.target.closest("button[data-copy]") : null;
    if (!button || !navigator.clipboard) return;
    navigator.clipboard.writeText(button.getAttribute("data-copy") || "").then(
      function () { button.textContent = "Copied"; },
      function () { button.textContent = "Select the text and copy it"; }
    );
  });
})();
