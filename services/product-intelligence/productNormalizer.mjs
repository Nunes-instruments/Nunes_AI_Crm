export function normalizeProductName(value='') {
  return String(value || '')
    .toUpperCase()
    .replace(/\bPLUS\b/g, ' PLUS ')
    .replace(/\+/g, ' PLUS ')
    .replace(/[^A-Z0-9/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactModel(value='') {
  return normalizeProductName(value).replace(/[^A-Z0-9]/g, '');
}

const BRAND_RULES = [
  [/\bUNI[-\s]?T\b/i,'UNI-T'], [/\bHTC\b/i,'HTC'], [/\bFLUKE\b/i,'Fluke'], [/\bOHAUS\b/i,'OHAUS'],
  [/\bMETRAVI\b/i,'Metravi'], [/\bHIOKI\b/i,'Hioki'], [/\bMEGGER\b/i,'Megger'], [/\bTESTO\b/i,'Testo'],
  [/\bHANNA\b/i,'Hanna'], [/\bEXTECH\b/i,'Extech'], [/\bKUSAM[-\s]?MECO\b/i,'Kusam Meco'],
  [/\bMITUTOYO\b/i,'Mitutoyo'], [/\bBROOKFIELD\b/i,'Brookfield'], [/\bMETTLER(?:\s+TOLEDO)?\b/i,'Mettler Toledo'], [/\bATAGO\b/i,'Atago'], [/\bUPCERA\b/i,'Upcera']
];

export function detectBrand(value='', existing='') {
  if (String(existing || '').trim()) return String(existing).trim();
  for (const [re, brand] of BRAND_RULES) if (re.test(String(value))) return brand;
  return '';
}

export function detectModel(value='', existing='') {
  if (String(existing || '').trim()) return String(existing).trim();
  const text = String(value || '').replace(/\bUNI[-\s]?T\b/ig,' ').replace(/\bHTC\b/ig,' ').replace(/\bATAGO\b/ig,' ').replace(/\bUPCERA\b/ig,' ').trim();
  const named = text.match(/\bMERA\s+PAL\b/i);
  if (named) return named[0].replace(/\s+/g,' ').trim();
  const shortModel = text.match(/\b[A-Z]{1,4}\d\+[A-Z0-9+./-]*(?=\s|$)/i);
  if (shortModel) return shortModel[0].trim();
  const candidates = text.match(/\b[A-Z]{1,8}[\s-]?\d{2,}[A-Z0-9+./-]*(?:\s+(?:PLUS|PRO|MAX|II|III))?\b/ig) || [];
  const model = candidates.map(x=>x.replace(/\s+/g,' ').trim()).find(x=>!/^SF\d+/i.test(x) && !/^20\d{2}$/.test(x));
  return model || '';
}

export function detectCategory(value='') {
  const n = String(value || '').toLowerCase();
  if (/digital\s+manometer.*(?:air\s*flow|airflow|flow)|(?:air\s*flow|airflow|flow).*digital\s+manometer/.test(n)) return 'Digital Manometer with Airflow';
  if (/differential\s+pressure.*(?:air\s*flow|airflow)|air\s*flow.*differential\s+pressure/.test(n)) return 'Digital Manometer with Airflow';
  if (/digital\s+manometer|differential\s+manometer|manometer/.test(n)) return 'Digital Manometer';
  if (/manual vacuum extractor|vacuum extractor|obstetric vacuum/.test(n)) return 'Medical Vacuum Extractor';
  if (/rubber roller sheeting|rubber sheeting machine|two roll rubber|rubber mixing mill|two roll mill/.test(n)) return 'Rubber Processing Machine';
  if (/breath alcohol|alcohol analyzer|alcohol analyser|breathalyzer|breathalyser/.test(n)) return 'Breath Alcohol Analyzer';
  if (/lux meter|light meter|illuminance/.test(n)) return 'Lux Meter';
  if (/oscilloscope|scopemeter|scope meter|\butd\s*\d|\bdso\s*\d/.test(n)) return 'Oscilloscope';
  if (/analytical balance|precision balance|micro balance|weighing balance/.test(n)) return 'Analytical Balance';
  if (/skinfold|skin fold.*caliper/.test(n)) return 'Skinfold Caliper';
  if (/uv meter|ultraviolet/.test(n)) return 'UV Meter';
  if (/freeze dryer|freeze drying|lyophili[sz]er|lyophili[sz]ation/.test(n)) return 'Freeze Dryer / Lyophilizer';
  if (/karl fischer|karl fisher|kf titrator/.test(n)) return 'Karl Fischer Titrator';
  if (/distillation|all glass/.test(n)) return 'Distillation Apparatus';
  if (/sintering furnace|muffle furnace|furnace/.test(n)) return 'Furnace';
  if (/gas detector|gas analyser|gas analyzer/.test(n)) return 'Gas Detector / Analyzer';
  if (/temperature calibrator|temperature calibration/.test(n)) return 'Temperature Calibrator';
  if (/data logger|datalogger/.test(n)) return 'Data Logger';
  if (/microscope/.test(n)) return 'Microscope';
  if (/pressure gauge|pressure meter/.test(n)) return 'Pressure Gauge';
  if (/caliper|vernier/.test(n)) return 'Caliper';
  if (/flow meter|flowmeter/.test(n)) return 'Flow Meter';
  if (/refractometer|brix meter|brix refract/.test(n)) return 'Refractometer';
  if (/air quality|iaq|pollution monitor/.test(n)) return 'Air Quality Monitor';
  if (/ph meter|phmeter/.test(n)) return 'pH Meter';
  if (/moisture/.test(n)) return 'Moisture Meter';
  if (/vibration/.test(n)) return 'Vibration Meter';
  return 'Instrument / Testing Equipment';
}

const CAPABILITY_RULES=[
  [/\b(?:air\s*flow|airflow|flow)\b/i,'Airflow / flow measurement'],
  [/\bdata\s*log(?:ger|ging)?\b|\blogging\b/i,'Data logging'],
  [/\bbluetooth\b/i,'Bluetooth connectivity'],
  [/\bwi[-\s]?fi\b/i,'Wi-Fi connectivity'],
  [/\b(?:usb|rs[-\s]?232|modbus|ethernet|lan)\b/i,'Communication interface'],
  [/\bprinter\b|\bprint(?:ing)?\b/i,'Printer / print output'],
  [/\bcertificate\b|\bcalibration\s+certificate\b|\bnabl\b/i,'Calibration / certificate requirement'],
  [/\bportable\b|\bhandheld\b/i,'Portable / handheld configuration'],
  [/\bbench(?:top)?\b/i,'Bench-top configuration'],
  [/\bprobe\b|\bsensor\b/i,'Probe / sensor requirement'],
  [/\btemperature\b/i,'Temperature measurement'],
  [/\bhumidity\b/i,'Humidity measurement'],
  [/\bdifferential\s+pressure\b/i,'Differential pressure measurement'],
  [/\bgauge\s+pressure\b/i,'Gauge pressure measurement']
];

function cleanRequestPart(value=''){
  return String(value||'').replace(/^[\s+,&/-]+|[\s+,&/-]+$/g,'').replace(/\s+/g,' ').trim();
}

function unique(values=[]){const out=[];for(const v of values){const x=String(v||'').trim();if(x&&!out.some(y=>y.toLowerCase()===x.toLowerCase()))out.push(x);}return out;}

export function interpretProductRequest(value='', extraContext=''){
  const original=String(value||'').replace(/\s+/g,' ').trim();
  const context=[original,String(extraContext||'').trim()].filter(Boolean).join(' | ');
  let base=original,modifier='';
  const withMatch=original.match(/^(.*?)(?:\s+with\s+|\s+w\/\s*)(.+)$/i);
  if(withMatch&&cleanRequestPart(withMatch[1]).length>=3){base=cleanRequestPart(withMatch[1]);modifier=cleanRequestPart(withMatch[2]);}
  else {
    const forMatch=original.match(/^(.*?)(?:\s+for\s+)(.+)$/i);
    if(forMatch&&cleanRequestPart(forMatch[1]).length>=5){base=cleanRequestPart(forMatch[1]);modifier=`For ${cleanRequestPart(forMatch[2])}`;}
  }
  const capabilities=[];
  for(const [re,label] of CAPABILITY_RULES)if(re.test(context))capabilities.push(label);
  if(modifier&&!capabilities.length)capabilities.push(modifier);
  const category=detectCategory(`${original} ${modifier}`);
  let meaning='';
  if(base&&modifier)meaning=`Customer is asking for ${base} with the additional requirement: ${modifier}.`;
  else if(capabilities.length)meaning=`Customer is asking for ${base||original} with ${capabilities.join(', ')}.`;
  else meaning=`Customer is asking for ${original||'the requested product'}.`;
  if(/digital\s+manometer/i.test(original)&&/(?:air\s*flow|airflow|\bflow\b)/i.test(original)){
    base='Digital Manometer';
    if(!capabilities.some(x=>/flow/i.test(x)))capabilities.unshift('Airflow / flow measurement');
    meaning='Customer is not asking for a basic digital manometer only; the requested configuration must measure pressure and also support airflow / flow-related measurement.';
  }
  const focus=[];const questions=[];
  if(/manometer/i.test(original)){
    focus.push('Pressure type and pressure range','Accuracy / resolution','Selectable pressure units','Over-pressure protection');
    questions.push('What pressure type and pressure range are required?','What accuracy and resolution are required?');
    if(capabilities.some(x=>/flow/i.test(x))){
      focus.push('Airflow velocity / flow calculation method','Compatible Pitot tube or airflow probe','Duct / area input for flow calculation');
      questions.push('What airflow / air velocity range is required?','Will the customer use a Pitot tube or another airflow probe?','Is direct air velocity enough, or must the instrument calculate volumetric flow using duct area?');
    }
    questions.push('Is data logging or USB / Bluetooth / other communication required?','Is a calibration certificate required?');
  }
  for(const c of capabilities)if(!focus.some(x=>x.toLowerCase().includes(c.toLowerCase().split(' ')[0])))focus.push(c);
  return {
    original_request:original,
    base_product:base||original,
    requested_modifier:modifier,
    requested_capabilities:unique(capabilities),
    interpreted_need:meaning,
    category,
    selection_focus:unique(focus),
    questions_to_confirm:unique(questions),
    sales_pitch:'',
    confidence: original? (modifier||capabilities.length?95:85):0
  };
}

export function productCacheKey({product_name='',brand='',model='',request_signature=''}) {
  const b = normalizeProductName(brand);
  const m = compactModel(model);
  const r=normalizeProductName(request_signature||'');
  if (m) return `${b || 'UNKNOWN'}::${m}${r?`::REQ:${r}`:''}`;
  return `NAME::${normalizeProductName(product_name)}${r?`::REQ:${r}`:''}`;
}
