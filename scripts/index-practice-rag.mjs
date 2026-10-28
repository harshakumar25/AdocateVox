import { openLegalStore } from '../src/store/db.js';
import { createPoliteFetcher } from '../src/sources/fetcher.js';
import { openCorpus } from '../src/rag/corpus.js';
import { indexPracticeCorpus } from '../src/rag/ingest.js';
import { PRACTICE_ACTS } from '../src/ingest/libraryCatalog.js';
const store=openLegalStore(); const corpus=openCorpus();
const fetcher=createPoliteFetcher({store,timeoutMs:15000});
const queue=PRACTICE_ACTS.filter((e)=>e.jurisdiction==='IN'); const results=[];
try {
  await Promise.all(Array.from({length:4},async()=>{
    while(queue.length){
      const entry=queue.shift();
      const [result]=await indexPracticeCorpus({store,corpus,fetcher,entries:[entry],force:process.argv.includes('--force'),recheck:process.argv.includes('--recheck')});
      results.push(result);console.log(JSON.stringify(result));
    }
  }));
  console.log(JSON.stringify({summary:results.reduce((s,r)=>(s[r.status]=(s[r.status]||0)+1,s),{})}));
} finally {corpus.close();store.close();}
