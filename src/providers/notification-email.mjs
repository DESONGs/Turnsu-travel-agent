/** Resend HTTP boundary. No recipient, message, key or provider body is logged. */
export function createNotificationMailer(env,fetchImpl=fetch){
  if(!env.TRAVEL_NOTIFICATION_EMAIL_KEY||!env.TRAVEL_NOTIFICATION_EMAIL_FROM)return null;
  return {async send({to,subject,text,key}){const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.TRAVEL_NOTIFICATION_EMAIL_KEY}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:env.TRAVEL_NOTIFICATION_EMAIL_FROM,to:[to],subject,text}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('notification_email_unavailable');const result=await response.json();if(typeof result.id!=='string')throw new Error('notification_email_outcome_unknown');return {id:result.id}}};
}
