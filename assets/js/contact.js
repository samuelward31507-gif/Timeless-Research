/* Account application form: client-side validation, request-list summary, and
   submission.

   CONFIGURE BEFORE LAUNCH -------------------------------------------------
   Set ENDPOINT to the URL that should receive the POST (your own handler, or a
   form service). While it is null the form falls back to composing an email in
   the visitor's mail client, which works but is not a substitute for a real
   endpoint: it depends on a configured mail client and leaves you no record. */
(function () {
  'use strict';

  var ENDPOINT = null;
  var FALLBACK_EMAIL = 'accounts@timelessresearch.com';

  var form = document.getElementById('account-form');
  if (!form) return;

  var status = document.getElementById('form-status');
  var esc = window.TR_esc || function (s) { return String(s); };

  /* ---- show the request list alongside the form ------------------------- */
  var list = (window.TR_RFQ && window.TR_RFQ.all()) || [];
  var summary = document.getElementById('rfq-summary');
  var summaryBody = document.getElementById('rfq-summary-body');
  if (list.length && summary && summaryBody) {
    summary.hidden = false;
    summaryBody.innerHTML = list.map(function (i) {
      return '<div style="display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--line)">' +
        '<span>' + esc(i.name) + '</span>' +
        '<span class="mono muted" style="font-size:.72rem">' + esc(i.size) + ' &times;' + i.qty + '</span></div>';
    }).join('');
  }

  /* ---- validation ------------------------------------------------------- */
  function fieldOf(el) { return el.closest('.field'); }

  function validate() {
    var ok = true;
    form.querySelectorAll('[required]').forEach(function (el) {
      var valid = el.type === 'checkbox' ? el.checked : el.value.trim() !== '';
      if (valid && el.type === 'email') valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(el.value.trim());
      var f = fieldOf(el);
      if (f) f.classList.toggle('is-invalid', !valid);
      if (!valid && ok) { el.focus(); ok = false; }
    });
    return ok;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate()) {
      if (status) status.innerHTML = '<p class="muted" style="color:#FF8A8A;font-size:.8rem">Please correct the highlighted fields.</p>';
      return;
    }

    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    data.request_list = list.map(function (i) { return i.name + ' ' + i.size + ' x' + i.qty; });

    if (ENDPOINT) {
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      if (status) status.innerHTML = '<p class="muted" style="font-size:.8rem">Submitting…</p>';
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        form.reset();
        if (status) status.innerHTML = '<p style="color:var(--ok);font-size:.85rem">Application received. We respond within two business days.</p>';
      }).catch(function () {
        if (status) status.innerHTML = '<p style="color:#FF8A8A;font-size:.85rem">Submission failed. Please email ' + FALLBACK_EMAIL + ' directly.</p>';
      }).finally(function () { btn.disabled = false; });
      return;
    }

    /* no endpoint configured — compose an email instead */
    var lines = [
      'Name: ' + (data.name || ''),
      'Role: ' + (data.role || ''),
      'Institution: ' + (data.organisation || ''),
      'Email: ' + (data.email || ''),
      'Country: ' + (data.country || ''),
      'Enquiry type: ' + (data.enquiry_type || ''),
      '',
      'Intended research use:',
      data.research_use || '',
      '',
      'Confirmed in vitro research use only: yes'
    ];
    if (data.request_list.length) {
      lines.push('', 'Request list:', data.request_list.join('\n'));
    }
    window.location.href = 'mailto:' + FALLBACK_EMAIL +
      '?subject=' + encodeURIComponent('Account application — ' + (data.organisation || '')) +
      '&body=' + encodeURIComponent(lines.join('\n'));
    if (status) status.innerHTML = '<p class="muted" style="font-size:.8rem">Your email client should now open with the application ready to send.</p>';
  });
})();
