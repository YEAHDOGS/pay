// Pay v3 landing behavior: reveal-on-scroll, notify form. No scroll listeners; IO-driven.
(function () {
  "use strict";

  // Staggered clip reveals on panel entry (transform/opacity only)
  var revealEls = document.querySelectorAll(".rv");
  // Hero children are in view at load: reveal immediately, no scroll needed.
  document.querySelectorAll("#hero .rv").forEach(function (el) {
    el.classList.add("in");
  });
  if ("IntersectionObserver" in window) {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          rio.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    revealEls.forEach(function (el) { rio.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  // Notify form: front-end only (no backend yet). Validates, then thanks.html.
  var form = document.querySelector("form[data-notify]");
  if (form) {
    var email = form.querySelector('input[type="email"]');
    var error = form.querySelector(".f-err");
    var button = form.querySelector("button");

    function setError(msg) {
      error.textContent = msg;
      email.setAttribute("aria-invalid", msg ? "true" : "false");
      if (msg) email.focus();
    }
    email.addEventListener("input", function () { setError(""); });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var value = email.value.trim();
      if (!value) { setError("Please enter your email address."); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        setError("That does not look like an email address.");
        return;
      }
      setError("");
      button.disabled = true;
      button.classList.add("loading");
      window.setTimeout(function () { window.location.href = "./thanks.html"; }, 800);
    });
  }
})();
