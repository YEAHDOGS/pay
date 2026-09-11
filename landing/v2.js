// Pay v2 landing behavior: reveal-on-scroll, sticky CTA, simulate demo, notify form.
(function () {
  "use strict";

  // Reveal on scroll (transform/opacity only; IO-driven, cheap)
  var revealEls = document.querySelectorAll(".rv");
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

  // Sticky mobile CTA: show once the hero CTA scrolls out of view
  var heroCta = document.querySelector(".hero-ctas");
  var sticky = document.getElementById("stickyCta");
  var notify = document.getElementById("notify");
  if (heroCta && sticky && "IntersectionObserver" in window) {
    var heroGone = false, atForm = false;
    var sync = function () { sticky.classList.toggle("show", heroGone && !atForm); };
    new IntersectionObserver(function (entries) {
      heroGone = !entries[0].isIntersecting;
      sync();
    }).observe(heroCta);
    if (notify) {
      new IntersectionObserver(function (entries) {
        atForm = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.15 }).observe(notify);
    }
  }

  // Simulate-a-send demo: replay the coin flight + receipt
  var demo = document.querySelector(".demo");
  var simulate = document.getElementById("simulate");
  if (demo && simulate) {
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var busy = false;
    simulate.addEventListener("click", function () {
      if (busy) return;
      busy = true;
      simulate.disabled = true;
      demo.classList.remove("sent");
      // force reflow so the animation restarts
      void demo.offsetWidth;
      if (reduced) {
        demo.classList.add("sent");
        busy = false;
        simulate.disabled = false;
        return;
      }
      window.requestAnimationFrame(function () {
        demo.classList.add("sent");
        window.setTimeout(function () {
          busy = false;
          simulate.disabled = false;
        }, 2200);
      });
    });
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
