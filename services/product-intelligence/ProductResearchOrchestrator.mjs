import { InternalProductProvider, DriveProductProvider, ManufacturerSearchProvider, IndiaMartProductResearchProvider, PublicWebProductProvider, compactResearchEvidence, directRecordFromEvidence } from './researchProviders.mjs';

function technicallySufficient(result={},minSpecs=6){const best=result?.best||result?.evidence?.[0];if(!best)return false;const values=(best.specifications||[]).filter(x=>String(x.value||'').trim()).length;return Number(best.confidence||0)>=82&&values>=minSpecs;}

export class ProductResearchOrchestrator{
  constructor({db,dataDir,geminiSynthesisProvider,manufacturerProvider=null,indiaMartProvider=null,publicWebProvider=null}={}){
    this.name='ProductResearchOrchestrator';
    this.internal=new InternalProductProvider({db});
    this.drive=new DriveProductProvider({dataDir});
    this.manufacturer=manufacturerProvider||new ManufacturerSearchProvider();
    this.indiamart=indiaMartProvider||new IndiaMartProductResearchProvider();
    this.publicWeb=publicWebProvider||new PublicWebProductProvider();
    this.synthesis=geminiSynthesisProvider;
  }
  status(){return {name:this.name,gemini_configured:Boolean(this.synthesis?.isConfigured?.()),indiamart_enabled:Boolean(this.indiamart?.enabled),providers:['InternalProductProvider','DriveProductProvider','ManufacturerSearchProvider','IndiaMartProductResearchProvider','PublicWebProductProvider','GeminiProductSynthesisProvider']};}
  async research(input={},options={}){
    const onStatus=typeof options.onStatus==='function'?options.onStatus:()=>{};const groups=[],trace=[];
    const run=async(status,key,provider)=>{onStatus(status);let result;try{result=await provider.research(input);}catch(e){result={status:'ERROR',evidence:[],errors:[e.message]};}groups.push(result);trace.push({provider:key,status:result.status,count:result.evidence?.length||0,errors:(result.errors||[]).slice(0,2)});return result;};
    const internal=await run('SEARCHING_INTERNAL','InternalProductProvider',this.internal);
    if(internal.complete){const result=directRecordFromEvidence(input,internal.best);return {...result,research_trace:trace};}
    const drive=await run('SEARCHING_DRIVE','DriveProductProvider',this.drive);
    if(drive.complete){const result=directRecordFromEvidence(input,drive.best);return {...result,research_trace:trace};}
    // Manufacturer/public evidence retrieval uses server-side Gemini grounding. If no
    // Gemini key is configured, IndiaMART alone is not presented as a synthesized final
    // answer; the staff UI gets one clear configuration message as requested.
    if(!this.synthesis?.isConfigured?.())return {status:'KEY_MISSING',error:'Gemini API key is missing from the server-side environment.',research_trace:trace,evidence:compactResearchEvidence(groups,input)};
    const fastMode=String(process.env.PRODUCT_RESEARCH_FAST_MODE||'true').toLowerCase()!=='false';
    if(!fastMode){
      const manufacturer=await run('SEARCHING_MANUFACTURER','ManufacturerSearchProvider',this.manufacturer);
      let market=null;
      if(!technicallySufficient(manufacturer,6))market=await run('SEARCHING_INDIAMART','IndiaMartProductResearchProvider',this.indiamart);
      const combinedHasEnough=technicallySufficient(manufacturer,6)||technicallySufficient(market,7);
      if(!combinedHasEnough)await run('SEARCHING_PUBLIC','PublicWebProductProvider',this.publicWeb);
    }else{
      // Fast mode avoids several sequential web/Gemini calls before synthesis. The
      // synthesis provider already uses Gemini Google Search grounding, so it can
      // research the exact product in one network round instead of 3-5 rounds.
      trace.push({provider:'FastGroundedResearch',status:'ENABLED',count:0,errors:[]});
    }
    const evidence=compactResearchEvidence(groups,input);
    onStatus('GENERATING');
    const research_sources=[];for(const e of evidence)for(const s of e.sources||[])research_sources.push(s);
    const result=await this.synthesis.analyze({...input,research_evidence:evidence,research_sources,provider_trace:trace},{force:options.force});
    if(result?.status!=='OK')return {...result,research_trace:trace};
    onStatus('COMPLETED');return {...result,research_trace:trace};
  }
}
