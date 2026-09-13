const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../assets/labs/ai-platform-workbench.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const startup = '    render();\n  }());';
assert.equal(script.split(startup).length, 2, 'Locate the workbench startup without changing production code');

function workbench() {
  const element = { addEventListener() {} };
  const context = vm.createContext({
    document: { getElementById: () => element, addEventListener() {} },
    exports: {}
  });
  // Skip only the first DOM render. Exercise the actual policy and artifact functions.
  vm.runInContext(script.replace(startup, '    Object.assign(exports, {state, configErrors, artifacts, activeScenario, otelSpan, renderDeploy});\n  }());'), context);
  return context.exports;
}

test('all six presets retain their default request and release outcomes', () => {
  const expected = {
    healthy: ['allowed', 'deployed'], outage: ['allowed', 'deployed'],
    'budget-warning': ['allowed', 'deployed'], 'budget-exhausted': ['blocked', 'blocked'],
    guardrail: ['blocked', 'deployed'], 'eval-regression': ['allowed', 'blocked']
  };
  for (const [scenario, states] of Object.entries(expected)) {
    const app = workbench();
    Object.assign(app.state, {mode: 'sandbox', scenario});
    const result = app.activeScenario();
    assert.deepEqual([result.requestState, result.deployState], states, scenario);
    if (result.requestState === 'blocked') {
      assert.equal(result.cost, 0);
      assert.equal(result.actualModel, 'not-called');
    }
  }
});

test('declared budgets enforce soft and hard limits, including the next request', () => {
  for (const [budget, route] of [['1200', 'primary'], ['855', 'budget-policy'], ['684', 'denied'], ['100', 'denied'], ['684.001', 'denied']]) {
    const app = workbench();
    Object.assign(app.state.config, {budget, riskTier: '1'});
    const result = app.activeScenario();
    assert.equal(result.route, route, budget);
    if (route === 'denied') assert.equal(result.deployState, 'blocked');
  }
});

test('budget presets scale their injected consumption to the declared limit', () => {
  for (const [scenario, fraction] of [['budget-warning', 0.8], ['budget-exhausted', 1]]) {
    const app = workbench();
    Object.assign(app.state, {mode: 'sandbox', scenario});
    app.state.config.budget = '5000';
    assert.equal(app.activeScenario().budgetUsed, 5000 * fraction);
  }
});

test('budget routing preserves outage provenance and evaluation failures', () => {
  const app = workbench();
  Object.assign(app.state, {mode: 'sandbox', scenario: 'outage'});
  Object.assign(app.state.config, {budget: '800', riskTier: '1'});
  let result = app.activeScenario();
  assert.equal(result.route, 'fallback');
  assert.equal(result.budgetWarning, true);
  assert.match(result.actualModel, /provider-b\/model-mini/);
  app.state.scenario = 'eval-regression';
  result = app.activeScenario();
  assert.equal(result.evalFailures, 3);
  assert.equal(result.deployState, 'blocked');
});

test('reviews match the entire declaration and cannot override other gates', () => {
  const app = workbench();
  assert.equal(app.activeScenario().review.approved, true);
  app.state.config.owner = 'another-team';
  assert.equal(app.activeScenario().review.approved, false);
  for (const tier of ['2', '3', '4']) {
    app.state.config.riskTier = tier;
    assert.equal(app.activeScenario().deployState, 'blocked');
  }
  assert.match(app.activeScenario().review.requirements.join(', '), /Executive sign-off/);
  app.state.reviewEvidence = {contract: JSON.stringify(app.state.config), id: 'test-review', source: 'Test fixture'};
  assert.equal(app.activeScenario().deployState, 'deployed');
  Object.assign(app.state, {mode: 'sandbox', scenario: 'eval-regression'});
  assert.equal(app.activeScenario().deployState, 'blocked');
  app.state.scenario = 'budget-exhausted';
  assert.equal(app.activeScenario().deployState, 'blocked');
  app.state.config.riskTier = '1';
  assert.equal(app.activeScenario().review.approved, true);
});

test('aliases resolve to distinct primary models', () => {
  const app = workbench();
  const models = new Set(['chat-default', 'extract-cheap', 'reason-deep'].map(alias => {
    app.state.config.alias = alias;
    return app.activeScenario().actualModel;
  }));
  assert.equal(models.size, 3);
});

test('invalid declarations cannot generate artifacts or approve a release', () => {
  const invalid = {service: ['', 'Bad Name', '<b>test</b>', 'a'.repeat(64)], owner: ['', ' '], costCenter: [''], budget: ['', '0', '-1', 'NaN', 'Infinity', '1e309'], riskTier: ['5'], alias: ['unknown'], tool: ['unknown']};
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) {
      const app = workbench();
      app.state.config[name] = value;
      assert.ok(app.configErrors()[name], `${name}: ${value}`);
      assert.throws(() => app.artifacts(), /Complete the workload/);
      assert.equal(app.activeScenario().deployState, 'blocked');
      assert.equal(app.activeScenario().requestState, 'blocked');
      assert.equal(app.activeScenario().cost, 0);
      assert.ok(!app.renderDeploy().includes('<b>test</b>'));
    }
  }
});

test('YAML artifacts preserve free-text strings and numeric budget types', () => {
  const values = ['Support: AI', 'null', 'yes', 'false', '4410', 'a"b\\c', 'team #1', 'line\nbreak'];
  const cases = values.map((owner, index) => {
    const app = workbench();
    const budget = ['1200.50', '1e3', '1e21', '1e-7'][index % 4];
    Object.assign(app.state.config, {owner, costCenter: owner, budget});
    return {owner, budget: Number(budget), yaml: app.artifacts()['platform.yaml']};
  });
  const ruby = `require 'json'; require 'yaml'
    JSON.parse(STDIN.read).each do |item|
      parsed = YAML.safe_load(item['yaml'])
      raise 'Owner changed' unless parsed['metadata']['owner'] == item['owner']
      raise 'Cost center changed' unless parsed['metadata']['costCenter'] == item['owner']
      raise 'Budget type changed' unless parsed['spec']['budget']['monthlyUSD'] == item['budget']
    end`;
  const result = spawnSync('ruby', ['-e', ruby], {input: JSON.stringify(cases), encoding: 'utf8'});
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});
