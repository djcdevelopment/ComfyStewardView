'use strict';

// The only script on the gateway, and it has exactly one job.
//
// The search box is a plain GET form pointed at the builders index, so it works with
// scripting off -- that is the point of building it this way. The one thing a plain form
// gets wrong is the empty submit: it navigates to /valheim/creators/?q= , which loads the
// whole directory and then filters it by a blank string, so the visitor pays a page load
// to arrive back where they started. Trim, and stay put if there is nothing to search for.

(function () {
  var form = document.querySelector('form[role="search"]');
  if (!form) return;
  var input = form.querySelector('input[name="q"]');
  if (!input) return;

  form.addEventListener('submit', function (event) {
    // Trim before the check and before the navigation: " ibocain " and "ibocain" should
    // reach the index as the same query string.
    input.value = input.value.trim();
    if (input.value) return;
    event.preventDefault();
    input.focus();
  });
})();
