// Progressive enhancement for the contacts list's bulk-delete bar: unhides
// the header select-all checkbox, keeps the "N selected" count live and only
// shows the Delete button while something is selected. Without this script
// (not yet approved, or JS off) the bar still works — row checkboxes submit
// via form="contacts-bulk-form", the host's data-confirm prompts, and the
// server bounces an empty selection back with a flash.
(function () {
  'use strict';

  var form = document.getElementById('contacts-bulk-form');
  if (!form) return;
  var checkboxes = Array.prototype.slice.call(document.querySelectorAll('[data-bulk-checkbox]'));
  if (!checkboxes.length) return;
  var selectAll = document.querySelector('[data-bulk-select-all]');
  var count = form.querySelector('[data-bulk-count]');
  var submit = form.querySelector('[data-bulk-submit]');

  function selectedCount() {
    return checkboxes.filter(function (checkbox) { return checkbox.checked; }).length;
  }

  function sync() {
    var selected = selectedCount();
    if (count) count.textContent = String(selected);
    if (submit) submit.hidden = selected === 0;
    if (selectAll) {
      selectAll.checked = selected > 0 && selected === checkboxes.length;
      selectAll.indeterminate = selected > 0 && selected < checkboxes.length;
    }
  }

  if (selectAll) {
    selectAll.hidden = false;
    selectAll.addEventListener('change', function () {
      checkboxes.forEach(function (checkbox) { checkbox.checked = selectAll.checked; });
      sync();
    });
  }

  checkboxes.forEach(function (checkbox) {
    checkbox.addEventListener('change', sync);
  });

  form.addEventListener('submit', function (event) {
    if (selectedCount() === 0) event.preventDefault();
  });

  sync();
}());
