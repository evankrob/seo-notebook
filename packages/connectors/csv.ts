// RFC4180 parser: quoted commas/newlines and doubled quotes; rejects malformed input.
export function parseCSV(text:string):Record<string,string>[] {
  if(text.length>1_000_000) throw new Error('CSV exceeds 1 MB');
  text=text.replace(/^\uFEFF/,'');
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
    if(c==='"'){if(field||closed)throw new Error('Unexpected quote');quoted=true;}
    else if(c===','||c==='\n'||c==='\r'){row.push(field);field='';closed=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(Boolean))rows.push(row);row=[];}}
    else {if(closed)throw new Error('Unexpected text after quote');field+=c;}
  }
  if(quoted)throw new Error('Unclosed quote');
  if(field||row.length){row.push(field);rows.push(row);}
  const header=rows.shift();if(!header||new Set(header).size!==header.length)throw new Error('Missing or duplicate CSV headers');
  if(rows.length>5000)throw new Error('CSV exceeds 5000 rows');
  return rows.map(r=>{if(r.length!==header.length)throw new Error('CSV column count mismatch');return Object.fromEntries(header.map((h,i)=>[h,r[i]]));});
}
export const csvCell=(v:unknown)=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
