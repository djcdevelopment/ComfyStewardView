const $ = id => document.getElementById(id);
const fixture = $('fixture'), viewSelect = $('view'), comparison = $('comparison');
const source = $('source'), renderer = $('render'), blend = $('blend'), isolate = $('isolate');
let model;

const vec = value => value.map(number => Number(number).toFixed(3)).join(',');
function selected(name) { return document.querySelector(`input[name=${name}]:checked`).value; }

async function loadFixture() {
  const response = await fetch(`../api/rnd/fidelity?cluster=${encodeURIComponent(fixture.value)}`);
  if (!response.ok) throw new Error((await response.json()).error || 'Could not load private corpus');
  model = await response.json();
  viewSelect.replaceChildren(...model.views.map((view,index) => {
    const option = document.createElement('option'); option.value = String(index);
    option.textContent = `${view.variant} · ${view.environment}`; return option;
  }));
  const result = model.promotion?.results?.find(value => value.prefab === 'windmill');
  const policy = model.promotion?.policy || {};
  $('promotion').textContent = result
    ? `${result.status.toUpperCase()} · ${result.reason || 'metric gates passed'}\nIoU ≥ ${policy.silhouetteIouMinimum ?? '.50'} · depth ≥ ${policy.depthOrderingMinimum ?? '.80'} · ΔIoU ≥ ${policy.medianIouImprovementMinimum ?? '.15'}`
    : 'No promotion receipt for this fixture.';
  showView();
}

function showView() {
  const view = model?.views?.[Number(viewSelect.value) || 0];
  if (!view) return;
  source.src = `../${view.image}`;
  const scope = model.scope;
  const query = new URLSearchParams({
    snapshot:'107', lens:'build-density', minX:scope.minX, maxX:scope.maxX,
    minZ:scope.minZ, maxZ:scope.maxZ, rnd:'1', presentation:selected('representation'),
    cameraLens:vec(view.lens), cameraAim:vec(view.aim), cameraFov:view.fov
  });
  renderer.src = `../scene.html?${query}`;
  $('render-label').textContent = `${selected('representation') === 'baseline' ? 'Baseline' : 'Candidate'} WebGPU proxy`;
  $('camera').textContent = `lens ${vec(view.lens)}\naim  ${vec(view.aim)}\nyaw ${view.yaw.toFixed(2)}° · pitch ${view.pitch.toFixed(2)}°\nvertical FOV ${view.fov}° · aspect ${view.aspect.toFixed(4)}`;
}

function applyCompare() {
  const mode = selected('mode'); comparison.dataset.mode = mode;
  $('blend-label').hidden = mode === 'side';
  const amount = Number(blend.value);
  const renderFigure = renderer.closest('figure');
  renderFigure.style.clipPath = mode === 'wipe' ? `inset(0 ${100-amount}% 0 0)` : '';
  renderFigure.style.opacity = mode === 'overlay' ? String(amount / 100) : '1';
}

function applyIsolation(attempt = 0) {
  const controls = renderer.contentWindow?.__stewardSceneControls;
  if (!controls && attempt < 50) {
    setTimeout(() => applyIsolation(attempt + 1), 100);
    return;
  }
  if (isolate.checked) controls?.setOnlyGroup?.('windmill');
  else controls?.restoreDefaultGroups?.();
}
renderer.addEventListener('load', () => applyIsolation());
fixture.addEventListener('change', () => loadFixture().catch(showError));
viewSelect.addEventListener('change', showView);
document.querySelectorAll('input[name=representation]').forEach(input => input.addEventListener('change', showView));
document.querySelectorAll('input[name=mode]').forEach(input => input.addEventListener('change', applyCompare));
blend.addEventListener('input', applyCompare);
isolate.addEventListener('change', () => {
  applyIsolation();
});
function showError(error) { $('promotion').textContent = error.message; }
applyCompare(); loadFixture().catch(showError);
