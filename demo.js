// demo.js — Démo mariage (30 sec)
// Pré-charge le buffer avec des conversations du mariage
// puis lance les 3 interactions via boutons séquentiels
(function () {
  "use strict";

  // Conversations du mariage à injecter dans le buffer
  const WEDDING_SEGMENTS = [
    "C'est magnifique cette cérémonie, les mariés étaient vraiment émus.",
    "Tu as vu quand ils ont échangé les alliances ? Tout le monde pleurait.",
    "Le discours du témoin était très touchant, il a raconté comment ils se sont rencontrés à Lyon.",
    "La robe de la mariée est superbe, elle l'a trouvée dans une petite boutique à Paris.",
    "Le traiteur a fait un travail incroyable, le cocktail sur la terrasse avec vue sur les montagnes c'est splendide.",
    "Tante Marie est venue de Bordeaux exprès, elle n'avait pas fait le voyage depuis deux ans.",
    "Les enfants sont adorables avec leurs petits costumes, le petit Lucas a porté les alliances sans les faire tomber.",
    "Le photographe a pris une photo de famille magnifique devant le grand chêne du jardin.",
    "Christine a dit que la pièce montée sera servie après la première danse.",
    "Regarde comme il est beau ton fils aujourd'hui, il a l'air tellement heureux.",
  ];

  const DEMO_STEPS = [
    {
      label: "1. Memory résume",
      input: "Memory résume",
      note: "→ Le système résume la cérémonie en cours",
    },
    {
      label: "2. Crée un souvenir",
      input: "Memory crée un souvenir de cette journée",
      note: "→ Le système propose un souvenir structuré du mariage",
    },
    {
      label: "3. Ajoute l'émotion",
      input: "Rajoute que j'étais ému aux larmes en voyant mon fils aussi heureux aujourd'hui",
      note: "→ Le système intègre l'émotion personnelle",
    },
    {
      label: "4. Confirme",
      input: "Oui garde ça",
      note: "→ Souvenir enregistré",
    },
  ];

  function seedBuffer() {
    if (!window._am) { alert("L'application n'est pas chargée."); return false; }

    // Inject wedding segments into the buffer via the state module
    const now = Date.now();
    for (let i = 0; i < WEDDING_SEGMENTS.length; i++) {
      // Stagger timestamps over the last 8 minutes so they look natural
      const delay = (WEDDING_SEGMENTS.length - i) * 45000; // 45s apart
      const ts = now - delay;

      // Use the public enqueue but mark as passive by not including wake word
      // We need to directly inject into the buffer via the app's addSegment
      // Since addSegment is in state.js module, we inject via a workaround:
      // send each segment as passive text (no "Memory" prefix)
      window._am.enqueue(WEDDING_SEGMENTS[i]);
    }
    return true;
  }

  function createDemoUI() {
    const section = document.createElement("section");
    section.className = "panel-section";
    section.id = "demo-section";
    section.innerHTML = `
      <h3>🎊 Démo mariage</h3>
      <button class="btn-sm" id="btn-seed" style="width:100%;padding:8px;margin-bottom:8px;background:rgba(165,130,255,.15);border-color:rgba(165,130,255,.4);color:#a582ff">
        1. Charger les conversations du mariage
      </button>
      <div id="demo-steps" style="display:none">
        ${DEMO_STEPS.map((s, i) => `
          <button class="btn-sm demo-step-btn" data-index="${i}" style="width:100%;padding:6px 10px;margin-bottom:4px;text-align:left;font-size:12px;line-height:1.3">
            <strong>${s.label}</strong><br>
            <span style="color:var(--text-faint);font-size:11px">${s.note}</span>
          </button>
        `).join("")}
      </div>
      <p id="demo-status" style="font-size:11px;color:var(--text-faint);margin-top:6px"></p>
    `;

    const leftPanel = document.getElementById("panel-left");
    if (leftPanel) leftPanel.insertBefore(section, leftPanel.firstChild);

    // Seed button
    document.getElementById("btn-seed").addEventListener("click", async () => {
      const btn = document.getElementById("btn-seed");
      btn.textContent = "Chargement…";
      btn.disabled = true;

      // Send segments one by one with small delays
      for (let i = 0; i < WEDDING_SEGMENTS.length; i++) {
        window._am.enqueue(WEDDING_SEGMENTS[i]);
        await new Promise(r => setTimeout(r, 400));
      }

      // Wait for processing
      await new Promise(r => setTimeout(r, 1000));

      btn.textContent = "✓ Conversations chargées";
      btn.style.background = "rgba(76,175,80,.15)";
      btn.style.borderColor = "rgba(76,175,80,.4)";
      btn.style.color = "#4caf50";

      document.getElementById("demo-steps").style.display = "block";
      document.getElementById("demo-status").textContent = `${WEDDING_SEGMENTS.length} segments injectés dans le buffer. Prêt pour la démo.`;
    });

    // Step buttons
    section.querySelectorAll(".demo-step-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index);
        const step = DEMO_STEPS[idx];
        window._am.enqueue(step.input);
        btn.style.opacity = "0.5";
        btn.disabled = true;
        document.getElementById("demo-status").textContent = `Envoyé : "${step.input.substring(0, 50)}…"`;
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Wait a bit for the app to initialize
    setTimeout(createDemoUI, 500);
  });
})();
