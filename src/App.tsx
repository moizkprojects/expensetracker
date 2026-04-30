import { useEffect, useMemo, useRef, useState } from "react";
import { ExpenseRow } from "./components/ExpenseRow";
import { searchOsmPlaces } from "./services/osmSearch";
import { resolveRate } from "./services/rateResolver";
import { RetentionService, SessionStore } from "./services/storage";
import type {
  DailySession,
  ExpenseRow as ExpenseRowType,
  OsmSuggestion,
  RateResolution,
  StoredExpense,
} from "./types";
import { computeBudget } from "./utils/budget";
import { randomId, toAmount, toDateKey, toUsd } from "./utils/normalize";

const todayKey = toDateKey(new Date());

const defaultResolution: RateResolution = {
  mieRate: 0,
  state: "",
  matchType: "unresolved",
  message: "Enter a city to look up the M&IE rate.",
};

const isEmptyRow = (row: ExpenseRowType) => !row.name.trim() && !row.amount.trim();

const toStoredExpenses = (rows: ExpenseRowType[]): StoredExpense[] =>
  rows
    .filter((row) => !isEmptyRow(row))
    .map((row) => ({ name: row.name.trim(), amount: toAmount(row.amount) }));

const hydrateRows = (expenses: StoredExpense[]): ExpenseRowType[] => {
  if (!expenses.length) return [{ id: randomId(), name: "", amount: "" }];
  return expenses.map((item) => ({
    id: randomId(),
    name: item.name,
    amount: item.amount.toString(),
  }));
};

const dateFromInput = (dateKey: string) => new Date(`${dateKey || todayKey}T12:00:00`);
const formatSavedDate = (dateKey: string) =>
  dateFromInput(dateKey).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const savedExpenseTotal = (session: DailySession) =>
  session.expenses.reduce((sum, item) => sum + item.amount, 0);
const effectivePerDiem = (rate: number, travelDay?: boolean) =>
  Number((travelDay ? rate * 0.75 : rate).toFixed(2));

function App() {
  const [initialSession] = useState(() => {
    RetentionService.prune();
    return SessionStore.getByDateKey(todayKey);
  });

  const [dateInput, setDateInput] = useState(initialSession?.dateKey ?? todayKey);
  const [locationInput, setLocationInput] = useState(initialSession?.locationInput ?? "");
  const [stateInput, setStateInput] = useState(initialSession?.stateInput ?? "");
  const [resolution, setResolution] = useState<RateResolution>(initialSession?.resolution ?? defaultResolution);
  const [travelDay, setTravelDay] = useState(initialSession?.travelDay ?? false);
  const [rows, setRows] = useState<ExpenseRowType[]>(hydrateRows(initialSession?.expenses ?? []));
  const [busy, setBusy] = useState(false);
  const [topTileCollapsed, setTopTileCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [savedSessions, setSavedSessions] = useState<DailySession[]>(() => SessionStore.list());
  const [saveStatus, setSaveStatus] = useState(initialSession ? "Saved for this date" : "");
  const [suggestions, setSuggestions] = useState<OsmSuggestion[]>([]);
  const [suggestionsBusy, setSuggestionsBusy] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const cacheRef = useRef<Map<string, OsmSuggestion[]>>(new Map());

  const expenses = useMemo(() => toStoredExpenses(rows), [rows]);
  const activePerDiem = useMemo(() => effectivePerDiem(resolution.mieRate, travelDay), [resolution.mieRate, travelDay]);
  const budget = useMemo(() => computeBudget(activePerDiem, expenses), [activePerDiem, expenses]);
  const remainingGood = budget.remaining >= 0;
  const hasRate = activePerDiem > 0;
  const isStandardFallback = resolution.matchType === "standard_oconus";

  useEffect(() => {
    const query = locationInput.trim();
    if (query.length < 3) {
      setSuggestions([]);
      setSuggestionsBusy(false);
      return;
    }

    const cacheKey = query.toLowerCase();
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setSuggestions(cached);
      setSuggestionsBusy(false);
      return;
    }

    const controller = new AbortController();
    setSuggestionsBusy(true);

    const timer = window.setTimeout(async () => {
      try {
        const result = await searchOsmPlaces(query, controller.signal);
        cacheRef.current.set(cacheKey, result);
        setSuggestions(result);
      } catch {
        setSuggestions([]);
      } finally {
        setSuggestionsBusy(false);
      }
    }, 700);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [locationInput]);

  const loadSessionForDate = (dateKey: string) => {
    const saved = SessionStore.getByDateKey(dateKey);
    if (!saved) {
      setResolution(defaultResolution);
      setTravelDay(false);
      setRows([{ id: randomId(), name: "", amount: "" }]);
      setSaveStatus("");
      return;
    }

    setLocationInput(saved.locationInput);
    setStateInput(saved.stateInput ?? "");
    setResolution(saved.resolution);
    setTravelDay(saved.travelDay ?? false);
    setRows(hydrateRows(saved.expenses));
    setSaveStatus("Saved for this date");
  };

  const openSavedSession = (session: DailySession) => {
    setDateInput(session.dateKey);
    setLocationInput(session.locationInput);
    setStateInput(session.stateInput ?? "");
    setResolution(session.resolution);
    setTravelDay(session.travelDay ?? false);
    setRows(hydrateRows(session.expenses));
    setSaveStatus("Loaded saved entry");
    setTopTileCollapsed(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const markUnsaved = () => {
    setSaveStatus("Unsaved changes");
  };

  const onResolve = async () => {
    setBusy(true);
    try {
      const result = await resolveRate(locationInput, stateInput, dateFromInput(dateInput));
      setResolution(result);
      setTopTileCollapsed(false);
      setSaveStatus("Unsaved changes");
    } catch {
      setResolution({
        ...defaultResolution,
        message: "Lookup failed. Try city + state, for example Austin, TX.",
      });
    } finally {
      setBusy(false);
    }
  };

  const onChangeRow = (id: string, next: ExpenseRowType) => {
    const updated = rows.map((row) => (row.id === id ? next : row));
    const firstEmptyIndex = updated.findIndex(isEmptyRow);
    const normalized =
      firstEmptyIndex === -1
        ? updated
        : updated.filter((row, index) => !isEmptyRow(row) || index === firstEmptyIndex);
    setRows(normalized);
    markUnsaved();
  };

  const onRemoveRow = (id: string) => {
    const next = rows.filter((row) => row.id !== id);
    const normalized = next.length ? next : [{ id: randomId(), name: "", amount: "" }];
    setRows(normalized);
    markUnsaved();
  };

  const onAddAnother = () => {
    if (rows.some(isEmptyRow)) return;
    const next = [...rows, { id: randomId(), name: "", amount: "" }];
    setRows(next);
    markUnsaved();
  };

  const onSave = () => {
    SessionStore.save({
      dateKey: dateInput || todayKey,
      locationInput,
      stateInput,
      travelDay,
      resolution,
      expenses,
    });
    setSavedSessions(SessionStore.list());
    setSaveStatus("Saved for this date");
  };

  const selectSuggestion = (item: OsmSuggestion) => {
    const nextCity = item.city || item.display.split(",")[0] || "";
    const nextLocation = item.stateCode ? `${nextCity}, ${item.stateCode}` : nextCity;
    setLocationInput(nextLocation);
    if (item.stateCode) setStateInput(item.stateCode);
    setShowSuggestions(false);
    markUnsaved();
  };

  return (
    <main className="app">
      {isStandardFallback ? (
        <section className="tile fallback-tile">
          <span>city/county were not found on the gsa site therefore a standard oconus rate is used for this location</span>
        </section>
      ) : null}

      <section className={`tile combined-tile ${topTileCollapsed ? "is-collapsed" : ""}`}>
        <div className="tile-header">
          <h1 className="title app-title">Travel Expense Tracker</h1>
        </div>

        <div className="collapsible-body">
          <div className="stack-section">
            <div className="rate-bubble">
              <span>{travelDay ? "Travel Day Per Diem" : "Per Diem Rate :"}</span>
              <strong>{hasRate ? toUsd(activePerDiem) : "$0.00"}</strong>
            </div>

            <div className="field-group">
              <label className="label" htmlFor="city">
                City
              </label>
              <input
                id="city"
                className="input"
                placeholder="Chicago or Chicago, IL"
                value={locationInput}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => window.setTimeout(() => setShowSuggestions(false), 150)}
                onChange={(e) => {
                  setLocationInput(e.target.value);
                  setShowSuggestions(true);
                  markUnsaved();
                }}
              />
              {showSuggestions ? (
                <div className="suggestions">
                  {suggestionsBusy ? <div className="suggestion-muted">Searching OpenStreetMap...</div> : null}
                  {!suggestionsBusy && suggestions.length === 0 && locationInput.trim().length >= 3 ? (
                    <div className="suggestion-muted">No OpenStreetMap suggestions yet.</div>
                  ) : null}
                  {suggestions.map((item) => (
                    <button
                      className="suggestion-item"
                      key={item.id}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        selectSuggestion(item);
                      }}
                    >
                      <span className="suggestion-top">
                        {item.city || item.display.split(",")[0]}
                        {item.stateCode ? `, ${item.stateCode}` : ""}
                      </span>
                      <span className="suggestion-bottom">
                        {item.county ? `${item.county} - ` : ""}
                        {item.display}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="field-group">
              <label className="label" htmlFor="state">
                State
              </label>
              <input
                id="state"
                className="input"
                placeholder="IL"
                maxLength={20}
                value={stateInput}
                onChange={(e) => {
                  setStateInput(e.target.value);
                  markUnsaved();
                }}
              />
            </div>

            <div className="field-group">
              <label className="label" htmlFor="date">
                Date
              </label>
              <input
                id="date"
                className="input"
                type="date"
                value={dateInput}
                onChange={(e) => {
                  const nextDate = e.target.value || todayKey;
                  setDateInput(nextDate);
                  loadSessionForDate(nextDate);
                }}
              />
            </div>

            <div className="field-group">
              <span className="label">Travel Day?</span>
              <div className="travel-toggle" role="group" aria-label="Travel Day">
                <button
                  className={!travelDay ? "travel-option is-active" : "travel-option"}
                  type="button"
                  onClick={() => {
                    setTravelDay(false);
                    markUnsaved();
                  }}
                >
                  No
                </button>
                <button
                  className={travelDay ? "travel-option is-active" : "travel-option"}
                  type="button"
                  onClick={() => {
                    setTravelDay(true);
                    markUnsaved();
                  }}
                >
                  Yes
                </button>
              </div>
            </div>

            <button className="btn btn-primary" onClick={onResolve} type="button" disabled={busy}>
              {busy ? "Finding Rate..." : "Find Rate"}
            </button>
            {resolution.message ? <p className="status">{resolution.message}</p> : null}
          </div>
        </div>

        <button
          className="toggle-button"
          type="button"
          aria-label={topTileCollapsed ? "Show tile" : "Hide tile"}
          onClick={() => setTopTileCollapsed((value) => !value)}
        >
          {topTileCollapsed ? "Toggle To Show Tile ^" : "Toggle To Hide Tile ^"}
        </button>
      </section>

      <section className="tile expense-tile">
        <h2 className="section-title">Enter Expenses Below</h2>
        {rows.map((row) => (
          <ExpenseRow
            key={row.id}
            row={row}
            removable={!isEmptyRow(row)}
            onChange={(next) => onChangeRow(row.id, next)}
            onRemove={() => onRemoveRow(row.id)}
          />
        ))}
        <button className="btn btn-secondary" type="button" onClick={onAddAnother}>
          Add More Expenses
        </button>
        <button className="save-button" type="button" onClick={onSave}>
          Save
        </button>
        {saveStatus ? <p className="save-status">{saveStatus}</p> : null}
      </section>

      <section className="tile calculator-tile">
        <p className="tile-kicker">Live calculator</p>
        <div className="calculator-grid">
          <div>
            <span className="stat-label">{travelDay ? "Travel day per diem" : "Per diem"}</span>
            <strong className="stat-value">{toUsd(activePerDiem || 0)}</strong>
          </div>
          <div>
            <span className="stat-label">Spent</span>
            <strong className="stat-value">{toUsd(budget.spent)}</strong>
          </div>
        </div>
        <div className={`balance ${remainingGood ? "good" : "bad"}`}>
          <span>{remainingGood ? "Amount left" : "Amount over"}</span>
          <strong>{toUsd(Math.abs(budget.remaining))}</strong>
        </div>
      </section>

      <section className={`tile history-tile ${historyCollapsed ? "is-collapsed" : ""}`}>
        <h2 className="section-title">Saved Entries</h2>
        <div className="history-body">
          {savedSessions.length ? (
            <div className="history-list">
              {savedSessions.map((session) => (
                <article
                  className={session.dateKey === dateInput ? "history-entry is-selected" : "history-entry"}
                  key={session.dateKey}
                  role="button"
                  tabIndex={0}
                  onClick={() => openSavedSession(session)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openSavedSession(session);
                    }
                  }}
                >
                  <strong>{formatSavedDate(session.dateKey)}</strong>
                  <span>{session.locationInput || "No location saved"}</span>
                  <span>{session.travelDay ? "Travel day per diem" : "Per diem"}: {toUsd(effectivePerDiem(session.resolution.mieRate || 0, session.travelDay))}</span>
                  <span>Total expenses: {toUsd(savedExpenseTotal(session))}</span>
                  <span className="history-open-label">Tap To Edit Entry</span>
                  {session.expenses.length ? (
                    <ul className="history-expenses">
                      {session.expenses.map((expense, index) => (
                        <li key={`${session.dateKey}-${expense.name}-${index}`}>
                          <span>{expense.name || "Unnamed expense"}</span>
                          <strong>{toUsd(expense.amount)}</strong>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="history-empty">No expenses saved for this day.</p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="history-empty">Saved entries will appear here after you tap Save.</p>
          )}
        </div>
        <button
          className="toggle-button"
          type="button"
          aria-label={historyCollapsed ? "Show saved entries" : "Hide saved entries"}
          onClick={() => setHistoryCollapsed((value) => !value)}
        >
          {historyCollapsed ? "Toggle To Show Saved Entries ^" : "Toggle To Hide Saved Entries ^"}
        </button>
      </section>
    </main>
  );
}

export default App;
