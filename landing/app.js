// DOGS style: y-scroll-snap panels + active dot tracking.
// Notify form is front-end only for now (no backend yet).
(function () {
  document.documentElement.classList.add('snap');

  // active dot follows the visible panel
  var dots = document.querySelectorAll('.dots a');
  var panels = document.querySelectorAll('.panel[id]');
  if (dots.length && 'IntersectionObserver' in window) {
    var byId = {};
    dots.forEach(function (d) { byId[d.getAttribute('href').slice(1)] = d; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          dots.forEach(function (d) { d.classList.remove('active'); });
          var d = byId[en.target.id];
          if (d) d.classList.add('active');
        }
      });
    }, { threshold: 0.55 });
    panels.forEach(function (p) { io.observe(p); });
  }

  var form = document.querySelector('form[data-notify]');
  if (!form) return;
  var email = form.querySelector('input[type="email"]');
  var error = form.querySelector('.field-error');
  var button = form.querySelector('button');

  function setError(msg) {
    error.textContent = msg;
    email.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) email.focus();
  }

  email.addEventListener('input', function () { setError(''); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = email.value.trim();
    if (!value) { setError('Please enter your email address.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('That does not look like an email address. Even a dog can tell.');
      return;
    }
    setError('');
    button.disabled = true;
    button.classList.add('loading');
    setTimeout(function () { window.location.href = './thanks.html'; }, 800);
  });
})();
