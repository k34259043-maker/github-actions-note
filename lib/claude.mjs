import { newId, parseJson } from './domain.mjs';

export function createGateway({ client, recorder, config }) {
  return {
    async call({stage,prompt,messages,schema,tools,model=config.generationModel,maxTokens=config.maxTokens}) {
      const callId=newId('call');
      const request={model,max_tokens:maxTokens,system:prompt.renderedTemplate??prompt.template,messages};
      if(schema) request.output_config={format:{type:'json_schema',schema}};
      if(tools) request.tools=tools;
      await recorder.append('call.started',{callId,stage,prompt,request});
      const started=performance.now();
      try {
        // SDK retries are disabled so each actual request has its own preserved call record.
        const response=await client.messages.create(request);
        const text=response.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??'';
        await recorder.append('call.completed',{callId,stage,response,usage:response.usage??null,model:response.model??model,stopReason:response.stop_reason,durationMs:Math.round(performance.now()-started),cost:null});
        if(response.stop_reason!=='end_turn') throw new Error(`Incomplete model response: ${response.stop_reason??'unknown'}`);
        if(!text.trim()) throw new Error('Model returned no text');
        return {callId,text,response,data:schema?parseJson(text):null};
      } catch(error) {
        const safe={name:error.name??'Error',message:error.status?`Model API request failed (${error.status})`:String(error.message).slice(0,400)};
        await recorder.append('call.failed',{callId,stage,error:safe,durationMs:Math.round(performance.now()-started)});
        throw new Error(safe.message);
      }
    }
  };
}
