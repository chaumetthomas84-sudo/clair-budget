// Moteur de calcul de Clair : solde, prévision jusqu'à la paie, point bas, épargne possible.
// Tous les montants internes sont en centimes entiers ; les dates sont des chaînes "AAAA-MM-JJ".
(function (root) {
  "use strict";

  const pad = n => String(n).padStart(2, "0");
  const cents = euros => Math.round(Number(euros) * 100);
  const sumCents = list => list.reduce((s, x) => s + x, 0);

  function parseDay(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function isoOf(date) { return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }
  function addDays(iso, n) { const d = parseDay(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); }
  function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 864e5); }
  function daysIn(month) { const [y, m] = month.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function shiftMonth(month, delta) { const [y, m] = month.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + delta, 1)); return isoOf(d).slice(0, 7); }
  function lastDayOf(month) { return `${month}-${pad(daysIn(month))}`; }
  // Un fixe prévu le 31 tombe le 30 en avril, le 28 ou 29 en février.
  function fixedDate(month, day) { return `${month}-${pad(Math.min(Math.max(1, day || 1), daysIn(month)))}`; }

  const signed = op => (op.type === "income" ? 1 : -1) * cents(op.amount);

  // Solde actuel : solde vérifié + opérations passées depuis ce jour-là.
  // Le jour même de la vérification, seules les opérations ajoutées après la saisie comptent.
  function balanceNow(state, today) {
    const b = state.balance;
    if (!b) return null;
    let total = cents(b.amount);
    for (const op of state.ops) {
      if (op.date > today) continue;
      if (op.date > b.date || (op.date === b.date && (op.created || 0) > b.at)) total += signed(op);
    }
    return total;
  }

  // Opérations connues entre demain et `until` inclus : opérations déjà posées (fixes du mois, saisies datées
  // dans le futur) et fixes des mois suivants, qui ne sont pas encore posés.
  function upcoming(state, today, until) {
    const events = state.ops
      .filter(op => op.date > today && op.date <= until)
      .map(op => ({ date: op.date, cents: signed(op), label: op.label || op.cat || "", fixedId: op.fixedId || null }));
    const skipped = new Set(state.skipped || []);
    for (let month = shiftMonth(today.slice(0, 7), 1); month <= until.slice(0, 7); month = shiftMonth(month, 1)) {
      for (const f of state.fixed) {
        if (f.from > month || skipped.has(`${f.id}|${month}`)) continue;
        if (state.ops.some(op => op.fixedId === f.id && op.date.startsWith(month))) continue;
        const date = fixedDate(month, f.day);
        if (date > today && date <= until) events.push({ date, cents: (f.type === "income" ? 1 : -1) * cents(f.amount), label: f.label, fixedId: f.id });
      }
    }
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.cents - b.cents);
  }

  // La paie est l'entrée fixe la plus importante ; on cherche sa prochaine date dans les deux mois.
  function nextPay(state, today) {
    const incomes = state.fixed.filter(f => f.type === "income");
    if (!incomes.length) return null;
    const main = incomes.reduce((a, b) => (cents(b.amount) > cents(a.amount) ? b : a));
    const event = upcoming(state, today, addDays(today, 62)).find(e => e.fixedId === main.id);
    return event ? { date: event.date, cents: event.cents, label: main.label, fixedId: main.id } : null;
  }

  // Dépense courante moyenne par jour (hors fixes, hors entrées), sur les 60 derniers jours.
  // Renvoie null tant qu'il y a moins de 4 semaines d'historique : pas d'estimation inventée.
  function dailySpending(state, today) {
    const from = addDays(today, -60);
    const past = state.ops.filter(op => op.date < today);
    if (!past.length) return null;
    const first = past.reduce((a, op) => (op.date < a ? op.date : a), today);
    const start = first > from ? first : from;
    const days = daysBetween(start, today);
    if (days < 28) return null;
    const spent = sumCents(past.filter(op => op.type === "expense" && !op.fixedId && op.date >= start).map(op => cents(op.amount)));
    return Math.round(spent / days);
  }

  function forecast(state, today, options = {}) {
    const reserve = cents(options.reserve || 0);
    const balance = balanceNow(state, today);
    const pay = nextPay(state, today);
    // Sans paie connue : jusqu'à la fin du mois budgétaire (fournie par l'appli), sinon fin du mois civil.
    const end = pay ? pay.date : options.end && options.end >= today ? options.end : lastDayOf(today.slice(0, 7));
    // Jours à vivre : jusqu'à la veille de la paie, ou jusqu'à la fin du mois inclus.
    const days = Math.max(1, pay ? daysBetween(today, end) : daysBetween(today, end) + 1);
    const events = upcoming(state, today, end).filter(e => !(pay && e.fixedId === pay.fixedId && e.date === pay.date));
    const toPay = sumCents(events.filter(e => e.cents < 0).map(e => -e.cents));
    const toReceive = sumCents(events.filter(e => e.cents > 0).map(e => e.cents));

    const result = { today, balance, pay, end, days, events, toPay, toReceive, reserve, available: null, perDay: null, low: null, overdraft: null, savings: null, spendingPerDay: dailySpending(state, today) };
    if (balance === null) return result;

    // Point bas avec les seules opérations connues (sans les dépenses courantes à venir).
    let running = balance, low = { cents: balance, date: today }, overdraft = null;
    for (const e of events) {
      running += e.cents;
      if (running < low.cents) low = { cents: running, date: e.date };
      if (running < 0 && !overdraft) overdraft = { cents: running, date: e.date, label: e.label };
    }
    if (balance < 0 && !overdraft) overdraft = { cents: balance, date: today, label: "" };

    // Ce qu'on peut dépenser sans passer sous zéro à aucun moment d'ici la paie :
    // une rentrée d'argent ne compte qu'à partir du jour où elle arrive.
    const available = low.cents - reserve;
    result.available = available;
    result.perDay = available > 0 ? Math.floor(available / days) : 0;
    result.low = low;
    result.overdraft = overdraft;
    // Épargne possible : ce qui reste après les dépenses courantes habituelles, arrondi à 10 € en dessous.
    if (result.spendingPerDay !== null) {
      const leftover = available - result.spendingPerDay * days;
      result.savings = leftover >= 1000 ? Math.floor(leftover / 1000) * 1000 : 0;
    }
    return result;
  }

  // « Est-ce que je peux dépenser X aujourd'hui ? »
  function canSpend(fc, amountCents) {
    if (!fc || fc.available === null) return null;
    const after = fc.available - amountCents;
    return { after, perDay: after > 0 ? Math.floor(after / fc.days) : 0, ok: after >= 0 };
  }

  const api = { cents, addDays, daysBetween, daysIn, shiftMonth, fixedDate, balanceNow, upcoming, nextPay, dailySpending, forecast, canSpend };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Moteur = api;
})(this);
