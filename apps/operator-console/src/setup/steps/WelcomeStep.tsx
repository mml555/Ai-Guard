/** First wizard step: explain Modelgov + offer the beginner quick-start path. */
export function WelcomeStep({
  onQuickStart,
  onCustomize,
}: {
  onQuickStart: () => void;
  onCustomize: () => void;
}) {
  return (
    <section className="setup-step">
      <h1>Welcome</h1>
      <p className="setup-lead">
        Modelgov sits between your app and AI providers. It enforces spending limits, safety
        rules, and who can use which models — so one misconfigured feature cannot drain your
        budget.
      </p>
      <div className="setup-info-grid">
        <div className="setup-info-tile">
          <h3>What you will choose</h3>
          <ul>
            <li>What your product does (support chat, SaaS tiers, etc.)</li>
            <li>Where AI runs (demo, OpenAI, Azure, local Ollama, …)</li>
            <li>Monthly spend cap and safety level</li>
          </ul>
        </div>
        <div className="setup-info-tile">
          <h3>What you do not need</h3>
          <ul>
            <li>Editing YAML or config files by hand</li>
            <li>Understanding LiteLLM or gateway internals</li>
            <li>An OpenAI account to try the demo</li>
          </ul>
        </div>
      </div>
      <div className="setup-quickstart-card">
        <div className="setup-quickstart-head">
          <span className="setup-badge setup-badge-accent">Recommended for beginners</span>
          <h2>Quick start — try Modelgov in 2 minutes</h2>
        </div>
        <p>
          Built-in demo AI (no sign-ups), customer support chat template, balanced safety, and a
          $200/month spend cap. You can switch to real providers later.
        </p>
        <ul className="setup-quickstart-list">
          <li>Demo AI — works immediately, no API keys</li>
          <li>Support chat — typical starter rules for a help widget</li>
          <li>Balanced safety — masks personal data in logs</li>
        </ul>
        <button type="button" className="setup-btn-primary" onClick={onQuickStart}>
          Use recommended settings
        </button>
      </div>
      <div className="setup-actions setup-actions-split">
        <button type="button" className="setup-btn-secondary" onClick={onCustomize}>
          Customize step by step
        </button>
      </div>
    </section>
  );
}
