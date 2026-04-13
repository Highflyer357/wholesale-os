import { useState, useCallback } from "react";

// ─── COPY OF APPS SCRIPT ────────────────────────────────────────────────────
const APPS_SCRIPT = `// ═══════════════════════════════════════════════════════════
// WHOLESALE OS — NIGHTLY AUTOMATION (Google Apps Script)
// ═══════════════════════════════════════════════════════════
// SETUP:
// 1. Open your Google Sheet
// 2. Extensions → Apps Script → paste this entire file
// 3. File → Project Settings → Script Properties
//    Add: CLAUDE_API_KEY = [your key from console.anthropic.com]
// 4. Run setup() once — creates all sheets + headers
// 5. Triggers: nightlyRun → 11pm | morningBrief → 6am
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  SHEET_PIPELINE:  'Pipeline',
  SHEET_INTEL:     'Seller Intel',
  SHEET_PORTFOLIO: 'Portfolio',
  SHEET_BUYERS:    'Buyers',
  SHEET_MARKET:    'Market Intel',
  YOUR_EMAIL:      'you@yourdomain.com',   // ← CHANGE THIS
  COMPANY_NAME:    'Your Company Name',    // ← CHANGE THIS
  CLAUDE_API:      'https://api.anthropic.com/v1/messages',
  CLAUDE_MODEL:    'claude-sonnet-4-20250514',
  KILL_ZIPS: ['39501','39502','39503','39504','39505','39506','39507',
              '39520','39521','39522','39523','39525','39529','39530',
              '39531','39532','39564','39565','39567','39571','39576'],
};

const C = {
  ROW_ID:0,DATE:1,ADDRESS:2,CITY:3,STATE:4,ZIP:5,
  PRICE:6,DOM:7,REDUCTIONS:8,LAST_REDUC:9,TYPE:10,UNITS:11,
  YEAR_BUILT:12,SQFT:13,OWNER_NAME:14,PHONE:15,EMAIL:16,
  OWNER_TYPE:17,YEARS_OWNED:18,EQUITY:19,FREE_CLEAR:20,
  ABSENTEE:21,TAX_DELQ:22,NBHD:23,CRIME:24,SCHOOL:25,
  VACANCY:26,FMR:27,RENT_EST:28,FLOOD:29,SEWER:30,HOA:31,
  CONDITION:32,SIGNALS:33,STREET_VIEW:34,
  SCORE:35,TIER:36,ACTION:37,COC_SF:38,COC_DSCR:39,
  DSCR:40,RENT_RATIO:41,SF_VIABLE:42,WS_SPREAD:43,
  OFFER_SF:44,OFFER_CASH:45,MOTIV:46,TOP_SIGNALS:47,
  RISKS:48,NEXT:49,SCORED:50,SCORED_DATE:51,
  OUTREACH:52,LAST_CONTACT:53,CONTACT_COUNT:54,
  VA_NOTES:55,INTEL_DONE:56,TIMELINE:57,OTHER_OFFERS:58,
  OFFER_DATE:59,OFFER_TERMS:60,COUNTER:61,COUNTER_AMT:62,
  DECISION:63,CONTRACT:64,CLOSE_DATE:65,PROFIT:66,SOURCE:67
};

function nightlyRun() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_PIPELINE);
  if (!sheet) { Logger.log('Pipeline sheet not found'); return; }
  const data = sheet.getDataRange().getValues();
  let processed=0, skipped=0, errors=0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[C.ADDRESS]) { skipped++; continue; }
    const scored = row[C.SCORED];
    if (scored===true||scored==='TRUE'||scored==='Y') { skipped++; continue; }

    const killReason = gate1Kill(row);
    if (killReason) {
      batchWrite(sheet, i+1, {
        [C.SCORE]:0,[C.TIER]:'REJECT',[C.ACTION]:'reject',
        [C.NEXT]:killReason,[C.SCORED]:'Y',
        [C.SCORED_DATE]:Utilities.formatDate(new Date(),'GMT','yyyy-MM-dd')
      });
      processed++; continue;
    }

    try {
      const result = scoreWithClaude(row);
      if (!result) { errors++; continue; }
      batchWrite(sheet, i+1, {
        [C.SCORE]:result.deal_score||0,
        [C.TIER]:result.tier||'cold',
        [C.ACTION]:result.action||'pass',
        [C.COC_SF]:result.coc_sf||'',
        [C.COC_DSCR]:result.coc_dscr||'',
        [C.DSCR]:result.dscr_ratio||'',
        [C.RENT_RATIO]:result.rent_ratio||'',
        [C.SF_VIABLE]:result.sf_viable||'N',
        [C.WS_SPREAD]:result.wholesale_spread||0,
        [C.OFFER_SF]:result.offer_price_sf||0,
        [C.OFFER_CASH]:result.offer_price_wholesale||0,
        [C.MOTIV]:result.motivation_score||0,
        [C.TOP_SIGNALS]:Array.isArray(result.top_3_signals)?result.top_3_signals.join(' | '):'',
        [C.RISKS]:Array.isArray(result.top_risk_flags)?result.top_risk_flags.join(' | '):'',
        [C.NEXT]:result.next_action||'pass',
        [C.SCORED]:'Y',
        [C.SCORED_DATE]:Utilities.formatDate(new Date(),'GMT','yyyy-MM-dd')
      });
      if ((result.deal_score||0)>=80||result.tier==='P1') fireP1Alert(row,result);
      processed++;
      Utilities.sleep(1500);
    } catch(e) { Logger.log('Row '+(i+1)+' error: '+e.toString()); errors++; }
  }
  Logger.log('Done — Processed:'+processed+' Skipped:'+skipped+' Errors:'+errors);
}

function gate1Kill(row) {
  const type  = String(row[C.TYPE]||'').toLowerCase();
  const flood = String(row[C.FLOOD]||'').toUpperCase().trim();
  const hoa   = String(row[C.HOA]||'').toUpperCase().trim();
  const nbhd  = String(row[C.NBHD]||'').toUpperCase().trim();
  const zip   = String(row[C.ZIP]||'').trim();
  const price = parseFloat(row[C.PRICE]||0);
  if (type.includes('condo'))                   return 'KILL: Condo';
  if (type.includes('manufactured'))            return 'KILL: Manufactured home';
  if (type.includes('mobile'))                  return 'KILL: Mobile home';
  if (['Y','YES','TRUE'].includes(hoa))          return 'KILL: HOA exists';
  if (['AE','VE','AO','A'].includes(flood))      return 'KILL: Flood zone '+flood;
  if (['D','F'].includes(nbhd))                  return 'KILL: '+nbhd+' neighborhood';
  if (CONFIG.KILL_ZIPS.includes(zip))            return 'KILL: Gulf Coast MS zip';
  if (price>0&&price>200000)                     return 'KILL: Over $200K ceiling';
  return null;
}

function scoreWithClaude(row) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) { Logger.log('MISSING: Set CLAUDE_API_KEY in Script Properties'); return null; }
  const response = UrlFetchApp.fetch(CONFIG.CLAUDE_API, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    payload:JSON.stringify({model:CONFIG.CLAUDE_MODEL,max_tokens:700,messages:[{role:'user',content:buildPrompt(row)}]}),
    muteHttpExceptions:true
  });
  const body = JSON.parse(response.getContentText());
  if (body.error) { Logger.log('Claude error: '+JSON.stringify(body.error)); return null; }
  const text = body.content[0].text.trim().replace(/\`\`\`json\\n?/g,'').replace(/\`\`\`\\n?/g,'');
  try { return JSON.parse(text); } catch(e) { Logger.log('Parse error: '+text.substring(0,300)); return null; }
}

function buildPrompt(row) {
  const p=Number(row[C.PRICE]||0), r=Number(row[C.RENT_EST]||0);
  const dp=p*0.07,note=p-dp,r_mo=0.01/12,n=60;
  const pmt_sf=note*(r_mo*Math.pow(1+r_mo,n))/(Math.pow(1+r_mo,n)-1);
  const eff=r*0.92,exp=eff*0.09+275,cf_sf=eff-exp-pmt_sf;
  const coc_sf=dp>0?((cf_sf*12)/dp*100).toFixed(1):'0';
  const dp2=p*0.25,loan=p-dp2,r2=0.075/12,n2=360;
  const pmt_d=loan*(r2*Math.pow(1+r2,n2))/(Math.pow(1+r2,n2)-1);
  const cf_d=eff-exp-pmt_d,coc_d=dp2>0?((cf_d*12)/dp2*100).toFixed(1):'0';
  const dscr=pmt_d>0?(r/pmt_d).toFixed(2):'0';
  const rr=p>0?((r/p)*100).toFixed(2):'0';
  const ws=Math.round(p*0.65-8000-3000);
  const addr=[row[C.ADDRESS],row[C.CITY],row[C.STATE],row[C.ZIP]].join(', ');
  return \`Score this property. Output ONLY valid JSON starting with {
ADDRESS: \${addr}
Price: $\${p.toLocaleString()} | DOM: \${row[C.DOM]} | Reductions: \${row[C.REDUCTIONS]}
Type: \${row[C.TYPE]} | Units: \${row[C.UNITS]} | Condition: \${row[C.CONDITION]}
Owner: \${row[C.OWNER_TYPE]} | Yrs owned: \${row[C.YEARS_OWNED]} | Equity: \${row[C.EQUITY]}%
Free/clear: \${row[C.FREE_CLEAR]} | Absentee: \${row[C.ABSENTEE]} | Tax delq: \${row[C.TAX_DELQ]}
Nbhd: \${row[C.NBHD]} | Conservative rent: $\${r}/mo | Vacancy: \${row[C.VACANCY]}%
Signals: \${row[C.SIGNALS]}
PRE-CALC: RR:\${rr}% SF_CoC:\${coc_sf}% DSCR_CoC:\${coc_d}% DSCR:\${dscr} WS:$\${ws}
{"deal_score":0-100,"tier":"P1|P2|P3|cold","action":"keep_sf|keep_dscr|wholesale|pass","coc_sf":"\${coc_sf}%","coc_dscr":"\${coc_d}%","dscr_ratio":\${dscr},"rent_ratio":"\${rr}%","sf_viable":true,"wholesale_spread":\${ws},"offer_price_sf":0,"offer_price_wholesale":0,"motivation_score":0-100,"top_3_signals":["","",""],"top_risk_flags":["",""],"next_action":"send_sf_offer|send_cash_offer|get_intel|pass","sf_pitch_angle":"tax_deferral|income|legacy|convenience","one_line_verdict":""}\`;
}

function fireP1Alert(row,r) {
  const addr=row[C.ADDRESS]+', '+row[C.CITY];
  GmailApp.sendEmail(CONFIG.YOUR_EMAIL,
    '🔥 P1 ALERT | Score '+r.deal_score+' | '+addr,
    ['=== P1 DEAL ===','Address: '+addr,'Score: '+r.deal_score,
     'CoC SF: '+r.coc_sf,'DSCR: '+r.dscr_ratio,
     'WS Spread: $'+(r.wholesale_spread||0).toLocaleString(),
     'Signals: '+(r.top_3_signals||[]).join(', '),
     'Next: '+r.next_action,'Verdict: '+r.one_line_verdict
    ].join('\\n'));
}

function morningBrief() {
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheet=ss.getSheetByName(CONFIG.SHEET_PIPELINE);
  if (!sheet) return;
  const data=sheet.getDataRange().getValues();
  const p1=[],warm=[];
  for (let i=1;i<data.length;i++) {
    const row=data[i];
    if (!row[C.ADDRESS]||row[C.SCORED]!=='Y') continue;
    const status=String(row[C.OUTREACH]||'').toLowerCase();
    if (row[C.TIER]==='P1'&&status!=='warm'&&status!=='offer sent')
      p1.push({addr:row[C.ADDRESS]+', '+row[C.CITY],score:row[C.SCORE]});
    if (status==='warm') warm.push(row[C.ADDRESS]+', '+row[C.CITY]);
  }
  GmailApp.sendEmail(CONFIG.YOUR_EMAIL,
    'Deal Brief — '+new Date().toLocaleDateString()+' — '+p1.length+' P1, '+warm.length+' warm',
    ['WHOLESALE OS — MORNING BRIEF','',
     '── P1 LEADS (contact today) ──',
     ...p1.slice(0,8).map(d=>'• '+d.addr+' | Score: '+d.score),
     p1.length===0?'(none)':'',
     '','── WARM LEADS (send offers) ──',
     ...warm.slice(0,5).map(a=>'• '+a),
     warm.length===0?'(none)':''
    ].join('\\n'));
}

function extractIntel(rowNum) {
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheet=ss.getSheetByName(CONFIG.SHEET_PIPELINE);
  const row=sheet.getRange(rowNum,1,1,70).getValues()[0];
  const notes=row[C.VA_NOTES];
  if (!notes) return;
  const apiKey=PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  const prompt=\`Extract seller intel from notes. Output ONLY valid JSON.
NOTES: "\${notes}"
PROPERTY: \${row[C.ADDRESS]}, \${row[C.CITY]}, \${row[C.STATE]}
{"urgency":0-10,"price_flex":0-10,"terms_open":0-10,"equity_aware":"low|medium|high",
"emotional_state":"calm|stressed|desperate|motivated","reason_selling":"",
"timeline_days":0,"competing_offers":false,"objections":["",""],
"rapport":0-5,"updated_motivation_score":0-100,
"recommended_next":"send_sf_offer|send_cash_offer|schedule_callback|pass",
"key_insight":"","va_coaching_note":""}\`;
  const resp=UrlFetchApp.fetch(CONFIG.CLAUDE_API,{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    payload:JSON.stringify({model:CONFIG.CLAUDE_MODEL,max_tokens:400,messages:[{role:'user',content:prompt}]}),
    muteHttpExceptions:true
  });
  const text=JSON.parse(resp.getContentText()).content[0].text.trim()
               .replace(/\`\`\`json\\n?/g,'').replace(/\`\`\`\\n?/g,'');
  const intel=JSON.parse(text);
  sheet.getRange(rowNum,C.INTEL_DONE+1).setValue('Y');
  sheet.getRange(rowNum,C.TIMELINE+1).setValue(intel.timeline_days||'');
  const iSheet=ss.getSheetByName(CONFIG.SHEET_INTEL);
  iSheet.appendRow([row[C.ROW_ID],row[C.ADDRESS]+', '+row[C.CITY],
    intel.urgency,intel.price_flex,intel.terms_open,intel.equity_aware,
    intel.emotional_state,intel.reason_selling,intel.timeline_days,'',
    intel.competing_offers,'','',
    intel.objections?intel.objections.join(', '):'',
    intel.rapport,new Date(),'','',intel.key_insight,'','']);
}

function batchWrite(sheet,rowNum,data) {
  Object.entries(data).forEach(([col,val])=>{
    sheet.getRange(rowNum,parseInt(col)+1).setValue(val);
  });
}

function setup() {
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheets=[
    ['Pipeline',['Row ID','Date Added','Address','City','State','Zip','List Price','DOM','Price Reductions','Last Reduction','Property Type','Units','Year Built','Sqft','Owner Name','Owner Phone','Owner Email','Owner Type','Years Owned','Equity %','Free & Clear','Absentee','Tax Delinquent','Nbhd Grade','Crime 90d','School Score','Vacancy %','FMR Rent','Rent Est','Flood Zone','Sewer','HOA','Condition','Signals','Street View Score','Deal Score','Tier','Action','CoC SF','CoC DSCR','DSCR Ratio','Rent Ratio','SF Viable','WS Spread','Offer SF','Offer Cash','Motivation Score','Top Signals','Risk Flags','Next Action','Scored','Scored Date','Outreach Status','Last Contact','Contact Count','VA Notes','Intel Done','Seller Timeline','Other Offers','Offer Date','Offer Terms','Counter','Counter Amt','Decision','Under Contract','Close Date','Profit/Fee','Source']],
    ['Seller Intel',['Lead ID','Address','Urgency','Price Flex','Terms Open','Equity Aware','Emotional State','Reason Selling','Timeline Days','Mortgage Bal','Other Offers','Repair Aware','Monthly Pmt','Objections','Rapport','Last Updated','Call Count','Best Call Time','Notes History','SF Benefit $','SF Pitch Angle']],
    ['Portfolio',['Prop ID','Address','City','State','Acq Date','Purchase Price','Down Pmt','SF Y/N','Note Balance','Rate %','Monthly P&I','Balloon Date','DSCR Lender','Loan Amount','Gross Rent','S8 Y/N','HAP Rent','Vacancy %','Mgmt Fee','Monthly Taxes','Monthly Insurance','Maintenance Res','CapEx Res','Net CF','Annual CoC %','Est Value','Equity','DSCR','PM Name','PM Phone','Tenant Name','Lease End','Rent Increase Due','Last Rent Increase','Units','Condition','Cost Seg Done','Annual Depreciation','Next Refi Review','Balloon Status','Exit Strategy']],
    ['Buyers',['Buyer ID','Name','Company','Phone','Email','Target Markets','Price Min','Price Max','Property Types','Min CoC','Financing','Avg Close Days','Deals Closed','Last Deal','Tier','Reliability Score','Total Fees Paid','Active','Notes']],
    ['Market Intel',['Date','City','State','Median DOM','DOM Trend','Avg List Price','Price Trend','Rent Growth %','Vacancy %','FMR 2BR','FMR 3BR','Cap Rate','Unemployment %','Pop Growth %','Stress Index','Permit Velocity','Notes']]
  ];
  sheets.forEach(([name,headers])=>{
    let sheet=ss.getSheetByName(name)||ss.insertSheet(name);
    const r=sheet.getRange(1,1,1,headers.length);
    r.setValues([headers]);
    r.setFontWeight('bold');
    r.setBackground('#1a1a2e');
    r.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  });
  Logger.log('✅ All 5 sheets created. Set CLAUDE_API_KEY in Script Properties, then add triggers.');
}`;

// ─── PROMPT LIBRARY ─────────────────────────────────────────────────────────
const PROMPTS = [
  {
    id:"scorer", label:"Deal scorer",
    desc:"Runs on every lead — returns full JSON verdict with score, CoC, DSCR, and recommended action.",
    text:`You are the acquisition analyst for [Company Name].
Score this property for wholesale or buy-and-hold acquisition.
Output ONLY valid JSON starting with { — zero other text.

ADDRESS: {address}, {city}, {state} {zip}
List price: ${"{price}"} | DOM: {dom} | Reductions: {reductions}
Type: {type} | Units: {units} | Condition: {condition}
Owner: {owner_type} | Years owned: {years_owned} | Equity: {equity}%
Free & clear: {free_clear} | Absentee: {absentee} | Tax delinquent: {tax_delq}
Neighborhood grade: {nbhd_grade} | Conservative rent: ${"{rent}"}/mo | Vacancy: {vacancy}%
Motivated signals: {signals}
PRE-CALC: RR:{rent_ratio}% SF_CoC:{coc_sf}% DSCR_CoC:{coc_dscr}% DSCR:{dscr} WS:${"{ws_spread}"}

{"deal_score":0-100,"tier":"P1|P2|P3|cold","action":"keep_sf|keep_dscr|wholesale|pass",
"coc_sf":"X%","coc_dscr":"X%","dscr_ratio":0.0,"rent_ratio":"X.XX%",
"sf_viable":true,"wholesale_spread":0,"offer_price_sf":0,"offer_price_wholesale":0,
"motivation_score":0-100,"top_3_signals":["","",""],"top_risk_flags":["",""],
"next_action":"send_sf_offer|send_cash_offer|get_intel|pass",
"sf_pitch_angle":"tax_deferral|income|legacy|convenience",
"one_line_verdict":""}`
  },
  {
    id:"offer", label:"Offer generator",
    desc:"Creates complete offer email + LOI + net-to-seller comparison + negotiation brief.",
    text:`You are the offer writer for [Company Name]. Generate a complete offer package. Output JSON only.

DEAL DATA: {deal_json}
SELLER INTEL: {intel_json}
YOUR BRAND: [Company Name] | [Your Name] | [Phone] | [Email]

Seller Finance targets: Price = asking (or up to 3% above if motivation > 75), Down = 7%, Rate = 0%, Term = 5yr balloon.

Generate:
1. Offer email (professional, property-specific, references seller situation)
2. LOI text (address, price, terms, contingencies, close date, assignment clause)
3. Net-to-seller comparison (your SF offer vs retail after 6% commission)
4. Installment sale tax benefit estimate
5. Pre-call negotiation brief (3 objections + exact rebuttals + walk-away)
6. Fallback cash offer B at 65% of list

{
  "email_subject":"","email_body":"","loi_text":"",
  "net_comparison":{"retail_net":0,"sf_net_total":0,"sf_advantage":0},
  "tax_deferral_savings_est":0,"monthly_payment_to_seller":0,
  "objections":[{"obj":"","rebuttal":""},{"obj":"","rebuttal":""},{"obj":"","rebuttal":""}],
  "walk_away_price":0,"offer_b_subject":"","offer_b_body":""
}`
  },
  {
    id:"intel", label:"Intel extractor",
    desc:"Runs after every VA call note — updates motivation profile with structured data.",
    text:`Extract seller intelligence from call notes. Output ONLY valid JSON starting with {

NOTES: "{va_notes}"
PROPERTY: {address}, {city}, {state}
PREVIOUS MOTIVATION SCORE: {prev_score}

{
  "urgency":0-10,"price_flex":0-10,"terms_open":0-10,
  "equity_aware":"low|medium|high",
  "emotional_state":"calm|stressed|desperate|motivated",
  "reason_selling":"","timeline_days":0,
  "competing_offers":false,"competing_offer_details":"",
  "monthly_mortgage_payment":0,
  "repair_aware":"not_aware|aware|priced_in",
  "objections_raised":["",""],"rapport_score":0-5,
  "updated_motivation_score":0-100,
  "recommended_next":"send_sf_offer|send_cash_offer|schedule_callback|pass",
  "callback_timing":"today|this_week|next_week",
  "key_insight":"one sentence for next touchpoint context",
  "va_coaching_note":"what VA should do differently"
}`
  },
  {
    id:"counter", label:"Counter analyzer",
    desc:"Models 3 response scenarios with full CoC impact on every seller counter.",
    text:`Analyze this counter-offer and recommend the best response. Output ONLY valid JSON starting with {

ORIGINAL OFFER: {our_offer_json}
SELLER COUNTER: Price: ${"{counter_price}"}, Terms: {counter_terms}
SELLER INTEL: {intel_json}
MY MINIMUMS: CoC ≥ 12% | Max down 10% | DSCR ≥ 1.25

{
  "accept_counter":false,"coc_if_accepted":"X%","coc_meets_12pct":false,
  "max_viable_price":0,"max_viable_price_coc":"X%",
  "scenario_1":{"label":"Accept counter","price":0,"coc":"X%","dscr":0,"pros":"","cons":"","recommended":false},
  "scenario_2":{"label":"Counter-counter","price":0,"terms":"","coc":"X%","dscr":0,"pros":"","cons":"","recommended":true},
  "scenario_3":{"label":"Walk away","pros":"","cons":"","recommended":false},
  "walk_away_threshold":0,"response_email_draft":"",
  "negotiation_tactic":"silence|anchor_lower|add_value|walk_away_threat",
  "probability_of_acceptance":"high|medium|low"
}`
  },
  {
    id:"brief", label:"Morning brief",
    desc:"Reads your full pipeline and builds a scannable daily action email.",
    text:`You are the operations AI for [Company Name]. Build today's deal brief. Plain text output only — no HTML.

PIPELINE SUMMARY: {pipeline_json}
DATE: {date}
PORTFOLIO COUNT: {portfolio_count}
CAPITAL AVAILABLE: ${"{capital}"}

Include:
1. Top 3 actions today (ranked by urgency and deal size)
2. P1 leads needing same-day contact (with scores)
3. Warm leads needing offers (with recommended action)
4. Counters pending response (with urgency)
5. Follow-ups due today
6. One market intelligence note

TONE: Direct. No fluff. Every line = action or data. Max 300 words.`
  }
];

// ─── OUTREACH TEMPLATES ──────────────────────────────────────────────────────
const TEMPLATES = [
  {
    id:"agent", label:"Agent email",
    tag:"Any listed property with a listing agent",
    text:`Subject: Fast close offer — [Address] — [Company Name]

Hi [Agent Name],

I'm [Your Name] with [Company Name], a local investment firm specializing in direct acquisitions with fast, clean closings.

I've reviewed [Address] and believe I can structure a strong offer for your seller — including the possibility of paying at or slightly above asking price through a structured arrangement that eliminates financing contingency delays.

Quick questions before I draft a formal offer:
• Is the seller open to creative financing or a seller carry-back?
• What's their ideal closing timeline?
• Are there other offers currently being reviewed?

I can have a written offer to you within 24 hours. I close with local title companies, and I have zero financing surprises.

Happy to take a 10-minute call today if easier.

[Your Name] | [Company Name] | [Phone] | [Email]`
  },
  {
    id:"sms", label:"Owner SMS",
    tag:"FSBO, off-market, and absentee owners",
    text:`Hi [First Name], this is [Your Name] with [Company Name]. I came across your property at [Address] — we buy direct from owners in [City] and I'd love to see if we might be a fit. We close fast, pay cash, or work with flexible terms around your timeline. Would you be open to a quick 5-min call this week? No pressure at all.`
  },
  {
    id:"sf", label:"SF offer email",
    tag:"Confirmed motivated seller — send after first call",
    text:`Subject: Purchase offer — [Address] — [Company Name]

Hi [Name],

Thank you for speaking with me about [Address]. Based on our conversation, I'd like to present the following:

━━ OFFER A — SELLER FINANCE TERMS ━━
Purchase Price:   $[Price] (your full asking price)
Down Payment:    $[Down] ([X]%) at closing
You Carry:        $[Note Balance] at [0–1]% interest
Monthly Payment: $[Payment]/month for [5] years
Balloon:          $[Balance] due [5 years from close]
Total You Receive: $[Total] over the term

━━ OFFER B — FAST CASH CLOSE ━━
Purchase Price:  $[65% of ARV]
Close in:         10–14 days, as-is, no repairs

I've attached a 1-page comparison showing your net under both options versus a traditional retail sale (after commissions and carrying costs). Most sellers find Offer A returns significantly more.

Happy to walk through the numbers — takes about 10 minutes, zero obligation.

[Your Name] | [Company Name] | [Phone] | [Email]`
  },
  {
    id:"counter", label:"Counter response",
    tag:"After seller counters your initial offer",
    text:`Subject: Re: [Address] — Updated offer

Hi [Name],

Thank you for coming back — I appreciate your transparency.

I've gone back through the numbers and here's where I can get to:

Purchase Price:   $[Adjusted Price]
Down Payment:    $[Adjusted Down] at close
Monthly Payment: $[Amount]/month ([Rate]%, [5-year] term)
Total over term:  approximately $[Total]

No buyer financing contingencies, no repair requests, close on your schedule.

If we can confirm these terms, I'll have the purchase agreement to you by [tomorrow].

What do you think?

[Your Name] | [Company]`
  },
  {
    id:"buyer", label:"Buyer blast",
    tag:"Send to tiered buyer list when deal is under contract",
    text:`[COMPANY NAME] — DEAL ALERT

Address:        [Address], [City], [State] [Zip]
Contract Price: $[Your price]
ARV:            $[ARV] (comps attached)
Repair Est:     $[Low]–$[High] | Condition: [grade]
Suggested Price:$[Buyer price]
Spread to ARV:  [X]%

FOR BUY-AND-HOLD BUYERS:
Gross rent est:  $[Rent]/mo ([X.XX]% rule)
DSCR at 25% dn:  [X.XX]
Projected CoC:   [X]%
Section 8:       [Y/N]

[Beds]br/[Bath]ba | [Sqft] sqft | Built [Year]

EMD required:  $[Amount] — nonrefundable after 48 hours
Target close:  [Date]

Reply or call [Phone] to reserve. First committed buyer with EMD wins.
Tier 1 window closes [48h from now].

[Company Name] | [Phone] | [Email]`
  }
];

// ─── CHECKLIST ───────────────────────────────────────────────────────────────
const CHECKLIST = [
  {phase:"Days 1–2: Foundation",color:"#ef4444",tasks:[
    "Open Mercury Bank (mercury.com) — create 4 accounts: Operating, Tax Reserve, Deal Reserves, Down Payment",
    "Set Mercury auto-transfer: 37% of any deposit > $5K → Tax Reserve account",
    "Open Wave Accounting (waveapps.com) — connect Mercury — free bookkeeping",
    "Open Ramp card (ramp.com) — free business credit card, builds your credit profile",
    "Register DUNS number (dnb.com) — free, takes 5 min — your business credit ID",
    "Create Google Sheet → Extensions → Apps Script → paste Apps Script → run setup()",
    "Add CLAUDE_API_KEY to Script Properties (get key at console.anthropic.com)",
    "Set two triggers: nightlyRun → 11pm daily | morningBrief → 6am daily",
    "Update CONFIG.YOUR_EMAIL and CONFIG.COMPANY_NAME in the script",
  ]},
  {phase:"Days 3–5: Tools activated",color:"#f59e0b",tasks:[
    "PropStream account — configure 5 saved searches (one per target market)",
    "Enable PropStream List Automator — auto-pull new leads weekly to CSV",
    "Set PropStream price-reduction alerts for all target zips",
    "OpenPhone ($15/mo) — get your company number — configure SMS automation",
    "VAPI account — build first voice script using the SF offer template above",
    "Connect Gmail MCP + Sheets MCP + Calendar MCP in Claude Cowork",
    "Test end-to-end: add 3 leads to Pipeline → run nightlyRun() → verify scored output",
    "Contact investor-friendly title company in each of your 5 target markets",
    "Schedule intro call with property manager in Indianapolis and Fort Wayne",
  ]},
  {phase:"Week 2: First leads",color:"#10b981",tasks:[
    "Export 50 leads from PropStream (equity 30%+, DOM 30+, target zips)",
    "Paste into Pipeline sheet — nightlyRun scores automatically overnight",
    "Review morning brief — identify top 10 P1 leads (score 80+)",
    "Send first 5 outreach campaigns using agent email template above",
    "Register as Section 8 landlord with housing authorities in Indy, Columbus, Birmingham",
    "Bookmark CrimeGrade.org + SpotCrime — run for any 70+ scored lead",
    "Join 1 local REIA per target market (BiggerPockets.com/groups)",
    "Identify 3 private money prospects in your network — schedule intro conversations",
  ]},
  {phase:"Week 3–4: First offers",color:"#3b82f6",tasks:[
    "Target: 3 offers sent this week minimum — use templates above",
    "Run Intel Extractor prompt on every warm response → update Seller Intel tab",
    "Build buyer list: post in 3 local Facebook RE investor groups",
    "Connect with 5 listing agents via LinkedIn + personalized outreach",
    "Run street view condition scoring on all 70+ leads via Claude Vision",
    "Order desktop appraisal ($75) on any lead scoring 80+",
    "Launch VAPI on top P1 lead — review call recording",
    "Wave bookkeeping — categorize all month-1 expenses",
  ]},
  {phase:"Month 2: First deal",color:"#8b5cf6",tasks:[
    "Target: 1 deal under contract (wholesale OR SF acquisition)",
    "If wholesale: send buyer blast within 24h of getting contract",
    "If acquisition: bind insurance + confirm PM + order CLUE report",
    "Set up Google Looker Studio dashboard connected to Pipeline Sheet",
    "Run first weekly metrics: leads scored, offers sent, contacts made, acceptance rate",
    "Schedule CPA consultation — discuss REPS qualification + cost segregation",
    "Log every objection from call notes — begin building your objection library",
    "Add second market to PropStream saved searches",
    "Reach out to 1 private lender prospect with formal investment overview",
  ]},
  {phase:"Month 3–6: Scale",color:"#06b6d4",tasks:[
    "Target: 2+ wholesale deals/month | 1 SF acquisition/month",
    "Hire first VA (REVA Global or MyOutDesk) — real estate specialist",
    "Upgrade PropStream List Automator to cover all 5 target markets",
    "Add ElevenLabs voice clone when VAPI exceeds 100 calls/month",
    "Apply for business line of credit using Ramp history + bank relationship",
    "Order cost segregation study on first 2 SF acquisitions",
    "Track: cost per deal, offer-to-close ratio, source ROI by lead type",
    "Build agent referral program — pay $3K per closed referral",
    "Recalibrate scoring weights based on first 10 deal outcomes",
  ]}
];

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]         = useState("scorer");
  const [copied, setCopied]   = useState("");
  const [scoring, setScoring] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState("");
  const [promptId, setPromptId] = useState("scorer");
  const [tplId, setTplId]       = useState("agent");
  const [colTab, setColTab]     = useState("pipeline");

  const [form, setForm] = useState({
    address:"123 Oak St", city:"Indianapolis", state:"IN", zip:"46201",
    price:"105000", dom:"87", reductions:"2", type:"SFR", units:"1",
    ownerType:"Absentee — out of state", yearsOwned:"14", equity:"52",
    freeClear:"N", absentee:"Y", taxDelq:"N",
    nbhd:"C+", rentEst:"1350", condition:"Fair",
    signals:"As-is listing, price reduced 2x, estate sale keywords"
  });

  const copy = useCallback((text, id) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id); setTimeout(() => setCopied(""), 2000);
    });
  }, []);

  const runScore = async () => {
    setScoring(true); setError(""); setResult(null);
    const p = Number(form.price)||0, r = Number(form.rentEst)||0;
    const dp=p*0.07, note=p-dp, rm=0.01/12, n=60;
    const pmt_sf = note*(rm*Math.pow(1+rm,n))/(Math.pow(1+rm,n)-1);
    const eff=r*0.92, exp=eff*0.09+275, cf_sf=eff-exp-pmt_sf;
    const coc_sf = dp>0 ? (cf_sf*12/dp*100).toFixed(1) : "0";
    const dp2=p*0.25, loan=p-dp2, r2=0.075/12, n2=360;
    const pmt_d = loan*(r2*Math.pow(1+r2,n2))/(Math.pow(1+r2,n2)-1);
    const cf_d=eff-exp-pmt_d;
    const coc_d = dp2>0 ? (cf_d*12/dp2*100).toFixed(1) : "0";
    const dscr  = pmt_d>0 ? (r/pmt_d).toFixed(2) : "0";
    const rr    = p>0 ? (r/p*100).toFixed(2) : "0";
    const ws    = Math.round(p*0.65-8000-3000);

    const prompt = `Score this property for real estate acquisition. Output ONLY valid JSON starting with {

PROPERTY: ${form.address}, ${form.city}, ${form.state} ${form.zip}
List price: $${p.toLocaleString()} | DOM: ${form.dom} | Reductions: ${form.reductions}
Type: ${form.type} | Units: ${form.units} | Condition: ${form.condition}
Owner type: ${form.ownerType} | Years owned: ${form.yearsOwned} | Equity: ${form.equity}%
Free & clear: ${form.freeClear} | Absentee: ${form.absentee} | Tax delinquent: ${form.taxDelq}
Neighborhood grade: ${form.nbhd} | Conservative rent: $${r}/mo
Motivated signals: ${form.signals}

PRE-CALC: RR:${rr}% SF_CoC:${coc_sf}% DSCR_CoC:${coc_d}% DSCR:${dscr} WS:$${ws.toLocaleString()}

OUTPUT ONLY this JSON (no other text):
{"deal_score":0-100,"tier":"P1|P2|P3|cold","action":"keep_sf|keep_dscr|wholesale|pass","coc_sf":"${coc_sf}%","coc_dscr":"${coc_d}%","dscr_ratio":${dscr},"rent_ratio":"${rr}%","sf_viable":true,"wholesale_spread":${ws},"offer_price_sf":0,"offer_price_wholesale":0,"motivation_score":0-100,"top_3_signals":["","",""],"top_risk_flags":["",""],"next_action":"send_sf_offer|send_cash_offer|get_intel|pass","sf_pitch_angle":"tax_deferral|income|legacy|convenience","one_line_verdict":""}`;

    try {
      const res = await fetch("/api/claude", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:700, messages:[{role:"user",content:prompt}] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const txt = data.content[0].text.trim().replace(/```json\n?/g,"").replace(/```\n?/g,"");
      setResult(JSON.parse(txt));
    } catch(e) { setError(e.message); }
    setScoring(false);
  };

  const tierColor = t => ({P1:"#ef4444",P2:"#f59e0b",P3:"#3b82f6",cold:"#6b7280",REJECT:"#374151"})[t]||"#6b7280";
  const actColor  = a => ({keep_sf:"#10b981",keep_dscr:"#10b981",wholesale:"#f59e0b",pass:"#6b7280",reject:"#374151"})[a]||"#6b7280";
  const scoreClr  = s => s>=80?"#10b981":s>=60?"#f59e0b":s>=40?"#3b82f6":"#6b7280";

  const TABS_CFG = [
    {id:"scorer",   label:"Live scorer",        accent:"#10b981"},
    {id:"sheets",   label:"Sheets schema",      accent:"#3b82f6"},
    {id:"script",   label:"Apps Script",        accent:"#8b5cf6"},
    {id:"prompts",  label:"Prompt library",     accent:"#f59e0b"},
    {id:"templates",label:"Outreach templates", accent:"#ef4444"},
    {id:"checklist",label:"Launch checklist",   accent:"#06b6d4"},
  ];

  const SCHEMA_TABS = {
    pipeline:  {label:"Pipeline (main — 68 cols)",  note:"Core lead pipeline. Every lead scored here nightly."},
    intel:     {label:"Seller Intel (21 cols)",      note:"Deep motivation data extracted after every call."},
    portfolio: {label:"Portfolio (41 cols)",         note:"Every acquisition tracked with full financials."},
    buyers:    {label:"Buyers (19 cols)",            note:"Vetted cash buyer database with scoring."},
    market:    {label:"Market Intel (17 cols)",      note:"Monthly market data per city — trend tracking."},
  };

  const SCHEMA_DATA = {
    pipeline: [
      ["A","Row ID","Auto-increment"],["B","Date Added","=TODAY()"],["C","Address","Text"],
      ["D","City","Text"],["E","State","IN/OH/TN/AL/MS"],["F","Zip","Text"],
      ["G","List Price","$"],["H","DOM","Days on market"],["I","Price Reductions","Count"],
      ["J","Last Reduction","Date"],["K","Property Type","SFR/Duplex/Triplex/Quad"],
      ["L","Units","1–4"],["M","Year Built","Year"],["N","Sqft","Number"],
      ["O","Owner Name","Text"],["P","Owner Phone","Skip traced"],["Q","Owner Email","Skip traced"],
      ["R","Owner Type","Individual/LLC/Trust/Estate"],["S","Years Owned","Number"],
      ["T","Equity %","PropStream"],["U","Free & Clear","Y/N"],
      ["V","Absentee","Y/N"],["W","Tax Delinquent","Y/N"],["X","Nbhd Grade","A–F"],
      ["Y","Crime 90d","SpotCrime count"],["Z","School Score","GreatSchools 1–10"],
      ["AA","Vacancy %","PropStream"],["AB","FMR Rent","HUD lookup"],
      ["AC","Rent Est","Conservative 10th pct"],["AD","Flood Zone","FEMA: X/AE/VE"],
      ["AE","Sewer/Septic","Sewer or Septic"],["AF","HOA","Y/N"],
      ["AG","Condition","Poor/Fair/Average/Good"],["AH","Signals","Motivated keywords"],
      ["AI","Street View Score","Claude Vision 1–10"],
      ["AJ","Deal Score","Claude output 0–100"],["AK","Tier","P1/P2/P3/cold/REJECT"],
      ["AL","Action","keep_sf/wholesale/pass"],["AM","CoC SF","% — Claude calc"],
      ["AN","CoC DSCR","% — Claude calc"],["AO","DSCR Ratio","Claude calc"],
      ["AP","Rent Ratio","% — Claude calc"],["AQ","SF Viable","Y/N"],
      ["AR","WS Spread","$ — Claude calc"],["AS","Offer Price SF","$"],
      ["AT","Offer Price Cash","$"],["AU","Motivation Score","0–100"],
      ["AV","Top Signals","Claude output"],["AW","Risk Flags","Claude output"],
      ["AX","Next Action","Claude output"],["AY","Scored","Y/N"],
      ["AZ","Scored Date","Date"],["BA","Outreach Status","Not Started/Sent/Replied/Warm"],
      ["BB","Last Contact","Date"],["BC","Contact Count","Number"],
      ["BD","VA Notes","Free text"],["BE","Intel Extracted","Y/N"],
      ["BF","Seller Timeline","Days"],["BG","Other Offers","Y/N"],
      ["BH","Offer Date","Date"],["BI","Offer Terms","Text"],
      ["BJ","Counter","Y/N"],["BK","Counter Amount","$"],
      ["BL","Decision","Accept/Counter/Walk"],["BM","Under Contract","Y/N"],
      ["BN","Close Date","Date"],["BO","Profit/Fee","$"],["BP","Source","Lead source"]
    ],
    intel: [
      ["A","Lead ID","Links to Pipeline A"],["B","Address","Text"],
      ["C","Urgency","0–10 (10=today)"],["D","Price Flex","0–10"],
      ["E","Terms Open","0–10"],["F","Equity Aware","Low/Med/High"],
      ["G","Emotional State","Calm/Stressed/Desperate/Motivated"],
      ["H","Reason Selling","Text"],["I","Timeline Days","Number"],
      ["J","Mortgage Bal","$"],["K","Other Offers","Y/N + details"],
      ["L","Repair Aware","Not aware/Aware/Priced in"],
      ["M","Monthly Pmt","$"],["N","Objections","CSV"],
      ["O","Rapport","1–5"],["P","Last Updated","Date"],
      ["Q","Call Count","Number"],["R","Best Call Time","Window"],
      ["S","Notes History","Timestamped"],["T","SF Benefit $","Claude calc"],
      ["U","SF Pitch Angle","tax_deferral/income/legacy/convenience"]
    ],
    portfolio: [
      ["A","Prop ID","Auto"],["B","Address","Text"],["C","City","Text"],["D","State","Text"],
      ["E","Acq Date","Date"],["F","Purchase Price","$"],["G","Down Pmt","$"],
      ["H","SF Y/N","Y/N"],["I","Note Balance","$"],["J","Rate %","Number"],
      ["K","Monthly P&I","$"],["L","Balloon Date","Date"],["M","DSCR Lender","Text"],
      ["N","Loan Amount","$"],["O","Gross Rent","$"],["P","S8 Y/N","Y/N"],
      ["Q","HAP Rent","$"],["R","Vacancy %","Number"],["S","Mgmt Fee","$"],
      ["T","Monthly Taxes","$"],["U","Monthly Insurance","$"],
      ["V","Maintenance Res","$"],["W","CapEx Res","$"],
      ["X","Net CF","=O*(1-R/100)-S-T-U-V-W-K"],
      ["Y","Annual CoC %","=(X*12)/G*100"],["Z","Est Value","$"],
      ["AA","Equity","=Z-N"],["AB","DSCR","=O/K"],
      ["AC","PM Name","Text"],["AD","PM Phone","Text"],
      ["AE","Tenant Name","Text"],["AF","Lease End","Date"],
      ["AG","Rent Increase Due","=AF-60"],["AH","Last Increase","Date"],
      ["AI","Units","Number"],["AJ","Cost Seg Done","Y/N"],
      ["AK","Annual Depr","$"],["AL","Balloon Status","Current/Due 12mo/Overdue"],
      ["AM","Next Refi Review","Date"],["AN","Exit Strategy","Hold/Refi/Sell/1031"]
    ],
    buyers: [
      ["A","Buyer ID","Auto"],["B","Name","Text"],["C","Company","Text"],
      ["D","Phone","Text"],["E","Email","Text"],
      ["F","Target Markets","CSV"],["G","Price Min","$"],["H","Price Max","$"],
      ["I","Property Types","SFR/Duplex/Multi"],["J","Min CoC","%"],
      ["K","Financing","Cash/DSCR/Hard Money"],["L","Avg Close Days","Number"],
      ["M","Deals Closed","Number"],["N","Last Deal","Date"],
      ["O","Tier","1/2/3"],["P","Reliability","1–10"],
      ["Q","Total Fees","$"],["R","Active","Y/N"],["S","Notes","Text"]
    ],
    market: [
      ["A","Date","Monthly"],["B","City","Text"],["C","State","Text"],
      ["D","Median DOM","Days"],["E","DOM Trend","Up/Flat/Down"],
      ["F","Avg List Price","$"],["G","Price Trend","Up/Flat/Down"],
      ["H","Rent Growth %","YoY"],["I","Vacancy %","Zip level"],
      ["J","FMR 2BR","HUD $"],["K","FMR 3BR","HUD $"],
      ["L","Cap Rate","Market"],["M","Unemployment %","BLS"],
      ["N","Pop Growth %","YoY"],["O","Stress Index","1–10"],
      ["P","Permit Velocity","Up/Flat/Down"],["Q","Notes","Text"]
    ]
  };

  // Shared styles
  const S = {
    bg:     {background:"#0d0d0d",minHeight:"100vh",color:"#e2e8f0",padding:16},
    card:   {background:"#111",border:"0.5px solid #1f1f1f",borderRadius:10,padding:14,marginBottom:10},
    input:  {width:"100%",background:"#0a0a0a",border:"0.5px solid #2d2d2d",borderRadius:6,
             color:"#e2e8f0",padding:"5px 8px",fontSize:12,boxSizing:"border-box"},
    select: {width:"100%",background:"#0a0a0a",border:"0.5px solid #2d2d2d",borderRadius:6,
             color:"#e2e8f0",padding:"5px 8px",fontSize:12},
    label:  {fontSize:10,color:"#4b5563",textTransform:"uppercase",letterSpacing:".05em",marginBottom:3,display:"block"},
    pre:    {background:"#080808",border:"0.5px solid #1a1a1a",borderRadius:8,padding:"12px 14px",
             fontSize:10,color:"#6b7280",overflowX:"auto",whiteSpace:"pre-wrap",
             wordBreak:"break-word",maxHeight:420,overflowY:"auto",lineHeight:1.65,marginBottom:0},
    chip:   (c,active) => ({
      padding:"4px 11px",borderRadius:16,fontSize:10,cursor:"pointer",border:"0.5px solid "+(active?c+"66":"#2a2a2a"),
      background:active?c+"22":"transparent",color:active?c:"#4b5563",transition:"all .12s"
    }),
  };

  const CopyBtn = ({text, id}) => (
    <button onClick={()=>copy(text,id)}
      style={{background:copied===id?"#10b981":"transparent",border:"0.5px solid "+(copied===id?"#10b981":"#333"),
              borderRadius:6,color:copied===id?"#000":"#6b7280",padding:"4px 11px",
              fontSize:10,cursor:"pointer",transition:"all .15s",flexShrink:0,whiteSpace:"nowrap"}}>
      {copied===id?"Copied ✓":"Copy"}
    </button>
  );

  const CodeWrap = ({text, id}) => (
    <div style={{position:"relative",marginBottom:10}}>
      <div style={{position:"absolute",top:8,right:8,zIndex:1}}><CopyBtn text={text} id={id}/></div>
      <pre style={S.pre}>{text}</pre>
    </div>
  );

  const Field = ({label, id, opts}) => (
    <div style={{marginBottom:7}}>
      <label style={S.label}>{label}</label>
      {opts
        ? <select value={form[id]} onChange={e=>setForm(f=>({...f,[id]:e.target.value}))} style={S.select}>
            {opts.map(o=><option key={o}>{o}</option>)}
          </select>
        : <input value={form[id]} onChange={e=>setForm(f=>({...f,[id]:e.target.value}))} style={S.input}/>
      }
    </div>
  );

  return (
    <div style={S.bg}>
      {/* ── HEADER ── */}
      <div style={{marginBottom:18,paddingBottom:14,borderBottom:"0.5px solid #1a1a1a"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:"#10b981",boxShadow:"0 0 6px #10b981"}}/>
            <span style={{fontSize:14,fontWeight:500,color:"#f1f5f9",letterSpacing:".02em"}}>
              WHOLESALE OS — PLATINUM EDITION
            </span>
          </div>
          <div style={{marginLeft:"auto",display:"flex",gap:20,flexWrap:"wrap"}}>
            {[{l:"Stack",v:"$134/mo"},{l:"Gates",v:"47 checks"},{l:"Auto",v:"78%"}].map(s=>(
              <div key={s.l} style={{textAlign:"right"}}>
                <div style={{fontSize:13,fontWeight:500,color:"#10b981"}}>{s.v}</div>
                <div style={{fontSize:9,color:"#374151",textTransform:"uppercase",letterSpacing:".05em"}}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{fontSize:10,color:"#374151",marginTop:5}}>
          AI-powered deal machine · PropStream + Claude + Google Workspace · $50M intelligence at solo operator cost
        </div>
      </div>

      {/* ── NAV ── */}
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:18}}>
        {TABS_CFG.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={S.chip(t.accent,tab===t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ══ SCORER ══ */}
      {tab==="scorer" && (
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:12}}>
          <div style={S.card}>
            <div style={{fontSize:10,color:"#10b981",textTransform:"uppercase",letterSpacing:".06em",marginBottom:12}}>Property data</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              <Field label="Address" id="address"/>
              <Field label="City" id="city"/>
              <Field label="State" id="state" opts={["IN","OH","TN","AL","MS"]}/>
              <Field label="Zip" id="zip"/>
              <Field label="List price ($)" id="price"/>
              <Field label="Days on market" id="dom"/>
              <Field label="Price reductions" id="reductions"/>
              <Field label="Property type" id="type" opts={["SFR","Duplex","Triplex","Quadplex"]}/>
              <Field label="Units" id="units" opts={["1","2","3","4"]}/>
              <Field label="Equity %" id="equity"/>
              <Field label="Years owned" id="yearsOwned"/>
              <Field label="Conservative rent ($)" id="rentEst"/>
              <Field label="Nbhd grade" id="nbhd" opts={["A","B","B+","B-","C+","C","C-","D","F"]}/>
              <Field label="Condition" id="condition" opts={["Good","Average","Fair","Poor"]}/>
            </div>
            <Field label="Motivated signals (listing keywords, situation)" id="signals"/>
            <button onClick={runScore} disabled={scoring}
              style={{width:"100%",marginTop:6,padding:"10px 0",borderRadius:8,border:"none",
                      background:scoring?"#1a1a1a":"#10b981",color:scoring?"#374151":"#000",
                      fontSize:12,fontWeight:500,cursor:scoring?"not-allowed":"pointer",transition:"all .2s"}}>
              {scoring?"Scoring with Claude AI...":"Run deal scorer ↗"}
            </button>
            {error && <div style={{marginTop:8,fontSize:11,color:"#ef4444",lineHeight:1.4}}>{error}</div>}
          </div>

          <div style={S.card}>
            <div style={{fontSize:10,color:"#10b981",textTransform:"uppercase",letterSpacing:".06em",marginBottom:12}}>Score result</div>
            {!result && !scoring && (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:220,color:"#2d2d2d",fontSize:12}}>
                Fill in property data → run scorer
              </div>
            )}
            {scoring && (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:220,color:"#374151",fontSize:11}}>
                Claude is analyzing...
              </div>
            )}
            {result && (
              <div>
                <div style={{display:"flex",gap:12,marginBottom:14,paddingBottom:14,borderBottom:"0.5px solid #1a1a1a"}}>
                  <div style={{textAlign:"center",minWidth:60}}>
                    <div style={{fontSize:44,fontWeight:500,color:scoreClr(result.deal_score),lineHeight:1}}>
                      {result.deal_score}
                    </div>
                    <div style={{fontSize:9,color:"#374151",textTransform:"uppercase"}}>score</div>
                  </div>
                  <div>
                    <div style={{display:"flex",gap:5,marginBottom:6,flexWrap:"wrap"}}>
                      {[{v:result.tier,c:tierColor(result.tier)},{v:(result.action||"").replace(/_/g," "),c:actColor(result.action)}].map((b,i)=>(
                        <span key={i} style={{fontSize:10,padding:"2px 7px",borderRadius:8,fontWeight:500,
                                              background:b.c+"22",color:b.c}}>{b.v}</span>
                      ))}
                    </div>
                    <div style={{fontSize:11,color:"#9ca3af",lineHeight:1.5}}>{result.one_line_verdict}</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:10}}>
                  {[
                    {l:"CoC — seller finance", v:result.coc_sf,    good:parseFloat(result.coc_sf)>=12},
                    {l:"CoC — DSCR",           v:result.coc_dscr,  good:parseFloat(result.coc_dscr)>=9},
                    {l:"DSCR ratio",           v:result.dscr_ratio,good:parseFloat(result.dscr_ratio)>=1.25},
                    {l:"Rent ratio",           v:result.rent_ratio,good:parseFloat(result.rent_ratio)>=1.25},
                    {l:"SF viable",            v:result.sf_viable?"Yes":"No",good:result.sf_viable},
                    {l:"Motivation",           v:(result.motivation_score||0)+"/100",good:(result.motivation_score||0)>=65},
                    {l:"SF offer",             v:"$"+(result.offer_price_sf||0).toLocaleString(),good:true},
                    {l:"WS spread",            v:"$"+(result.wholesale_spread||0).toLocaleString(),good:(result.wholesale_spread||0)>=10000},
                  ].map(m=>(
                    <div key={m.l} style={{background:"#0a0a0a",borderRadius:6,padding:"7px 9px"}}>
                      <div style={{fontSize:9,color:"#374151",textTransform:"uppercase",letterSpacing:".04em",marginBottom:2}}>{m.l}</div>
                      <div style={{fontSize:13,fontWeight:500,color:m.good?"#10b981":"#ef4444"}}>{m.v}</div>
                    </div>
                  ))}
                </div>
                {(result.top_3_signals||[]).filter(Boolean).length > 0 && (
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:9,color:"#374151",textTransform:"uppercase",letterSpacing:".04em",marginBottom:4}}>Top signals</div>
                    {result.top_3_signals.filter(Boolean).map((s,i)=>(
                      <div key={i} style={{fontSize:11,color:"#10b981",padding:"2px 0"}}>+ {s}</div>
                    ))}
                  </div>
                )}
                {(result.top_risk_flags||[]).filter(Boolean).length > 0 && (
                  <div>
                    <div style={{fontSize:9,color:"#374151",textTransform:"uppercase",letterSpacing:".04em",marginBottom:4}}>Risk flags</div>
                    {result.top_risk_flags.filter(Boolean).map((s,i)=>(
                      <div key={i} style={{fontSize:11,color:"#ef4444",padding:"2px 0"}}>⚠ {s}</div>
                    ))}
                  </div>
                )}
                {result.next_action && (
                  <div style={{marginTop:10,padding:"7px 10px",background:"#10b98118",borderRadius:6,fontSize:11,color:"#10b981"}}>
                    Next: {result.next_action.replace(/_/g," ")} · SF pitch: {result.sf_pitch_angle}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ SHEETS ══ */}
      {tab==="sheets" && (
        <div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:12}}>
            {Object.entries(SCHEMA_TABS).map(([k,v])=>(
              <button key={k} onClick={()=>setColTab(k)} style={S.chip("#3b82f6",colTab===k)}>
                {v.label}
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:"#4b5563",marginBottom:10,padding:"8px 12px",background:"#0a0a0a",borderRadius:6}}>
            {SCHEMA_TABS[colTab]?.note} — Run <code style={{color:"#8b5cf6"}}>setup()</code> in Apps Script to create all 5 sheets automatically.
          </div>
          <div style={{background:"#080808",border:"0.5px solid #1a1a1a",borderRadius:8,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"36px 120px 1fr 1fr",
                         padding:"6px 12px",background:"#0f0f0f",
                         fontSize:9,color:"#374151",textTransform:"uppercase",
                         letterSpacing:".06em",borderBottom:"0.5px solid #1a1a1a"}}>
              <div>Col</div><div>Field</div><div>Description</div><div>Source / formula</div>
            </div>
            {(SCHEMA_DATA[colTab]||[]).map(([col,name,desc,src],i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"36px 120px 1fr 1fr",
                                   padding:"5px 12px",fontSize:11,
                                   background:i%2===0?"#080808":"#090909",
                                   borderBottom:"0.5px solid #0f0f0f"}}>
                <div style={{color:"#374151",fontWeight:500}}>{col}</div>
                <div style={{color:"#d1d5db"}}>{name}</div>
                <div style={{color:"#6b7280"}}>{desc}</div>
                <div style={{color:"#374151",fontStyle:"italic"}}>{src||""}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══ APPS SCRIPT ══ */}
      {tab==="script" && (
        <div>
          <div style={{...S.card,background:"#0a000f",border:"0.5px solid #2d1b4e",marginBottom:12}}>
            <div style={{fontSize:10,color:"#8b5cf6",textTransform:"uppercase",letterSpacing:".06em",marginBottom:8}}>
              4-step setup
            </div>
            {[
              "1. Open your Google Sheet → Extensions → Apps Script",
              "2. Paste the entire script below → save",
              "3. File → Project Settings → Script Properties → Add: CLAUDE_API_KEY = [your key from console.anthropic.com]",
              "4. Run setup() once → then add 2 triggers: nightlyRun at 11pm + morningBrief at 6am"
            ].map((s,i)=>(
              <div key={i} style={{fontSize:11,color:"#9ca3af",padding:"3px 0",lineHeight:1.5}}>{s}</div>
            ))}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:10,color:"#374151"}}>Complete Apps Script — paste into Extensions → Apps Script</div>
            <CopyBtn text={APPS_SCRIPT} id="apps_full"/>
          </div>
          <CodeWrap text={APPS_SCRIPT} id="apps_inline"/>
        </div>
      )}

      {/* ══ PROMPTS ══ */}
      {tab==="prompts" && (
        <div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:12}}>
            {PROMPTS.map(p=>(
              <button key={p.id} onClick={()=>setPromptId(p.id)} style={S.chip("#f59e0b",promptId===p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          {PROMPTS.filter(p=>p.id===promptId).map(p=>(
            <div key={p.id}>
              <div style={{...S.card,background:"#0a0800",border:"0.5px solid #3d2e00",marginBottom:10}}>
                <div style={{fontSize:13,fontWeight:500,color:"#f59e0b",marginBottom:4}}>{p.label}</div>
                <div style={{fontSize:11,color:"#9ca3af"}}>{p.desc}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:10,color:"#374151"}}>Replace {"{brackets}"} with actual values</div>
                <CopyBtn text={p.text} id={"p_"+p.id}/>
              </div>
              <CodeWrap text={p.text} id={"pi_"+p.id}/>
            </div>
          ))}
        </div>
      )}

      {/* ══ TEMPLATES ══ */}
      {tab==="templates" && (
        <div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:12}}>
            {TEMPLATES.map(t=>(
              <button key={t.id} onClick={()=>setTplId(t.id)} style={S.chip("#ef4444",tplId===t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          {TEMPLATES.filter(t=>t.id===tplId).map(t=>(
            <div key={t.id}>
              <div style={{...S.card,background:"#0f0505",border:"0.5px solid #3b1515",marginBottom:10}}>
                <div style={{fontSize:13,fontWeight:500,color:"#ef4444",marginBottom:4}}>{t.label}</div>
                <div style={{fontSize:11,color:"#9ca3af"}}>Use for: {t.tag}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:10,color:"#374151"}}>Replace all [brackets] with actual values</div>
                <CopyBtn text={t.text} id={"t_"+t.id}/>
              </div>
              <CodeWrap text={t.text} id={"ti_"+t.id}/>
            </div>
          ))}
        </div>
      )}

      {/* ══ CHECKLIST ══ */}
      {tab==="checklist" && (
        <div>
          {CHECKLIST.map((ph,pi)=>(
            <div key={pi} style={{marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:ph.color,flexShrink:0}}/>
                <div style={{fontSize:12,fontWeight:500,color:ph.color}}>{ph.phase}</div>
              </div>
              {ph.tasks.map((task,ti)=>(
                <div key={ti} style={{display:"flex",gap:10,padding:"7px 12px",
                                      background:ti%2===0?"#0a0a0a":"transparent",
                                      borderRadius:6,marginBottom:2,alignItems:"flex-start"}}>
                  <div style={{width:14,height:14,borderRadius:3,border:"0.5px solid #2d2d2d",
                               flexShrink:0,marginTop:2}}/>
                  <div style={{fontSize:12,color:"#9ca3af",lineHeight:1.45}}>{task}</div>
                </div>
              ))}
            </div>
          ))}
          <div style={{padding:14,background:"#051505",border:"0.5px solid #14532d",borderRadius:10,marginTop:8}}>
            <div style={{fontSize:11,color:"#10b981",marginBottom:4,fontWeight:500}}>Month 1 targets</div>
            <div style={{fontSize:11,color:"#4b5563",lineHeight:1.7}}>
              50+ leads scored · 15+ contacts made · 5+ offers sent · 1 deal under contract<br/>
              Stack cost: $134/mo · Your time: 30 min/day · First deal: 3–5 weeks from launch
            </div>
          </div>
        </div>
      )}

      {/* ── FOOTER ── */}
      <div style={{marginTop:20,paddingTop:12,borderTop:"0.5px solid #111",
                   display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:9,color:"#1f1f1f"}}>WHOLESALE OS · PLATINUM EDITION</div>
        <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
          {[{l:"PropStream",v:"$99"},{l:"Claude",v:"$20"},{l:"OpenPhone",v:"$15"},{l:"VAPI",v:"~$10"},{l:"Google",v:"Free"}].map(s=>(
            <div key={s.l} style={{textAlign:"right"}}>
              <div style={{fontSize:11,fontWeight:500,color:"#10b981"}}>{s.v}</div>
              <div style={{fontSize:9,color:"#1f2937"}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
