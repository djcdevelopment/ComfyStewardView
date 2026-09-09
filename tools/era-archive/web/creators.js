'use strict';
(async () => {
  const $=id=>document.getElementById(id);
  const segments=location.pathname.split('/').filter(Boolean);
  const key=segments.find(s=>/^[a-f0-9]{32}$/.test(s));
  const base=new URL(key?'../':'./',location.href);
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  const link=(text,url)=>{const n=node('a',text);n.href=url;return n;};
  const read=async name=>{const r=await fetch(new URL(name,base));if(!r.ok)throw Error('The archive could not be opened.');return r.json();};
  try {
    const directory=await read('directory.json');
    const unresolved=directory.legacyImports.reduce((n,e)=>n+e.unresolvedImages,0);
    if(unresolved)document.querySelector('footer').append(` ${unresolved.toLocaleString()} historical photographs remain in their original galleries while creator attribution is unresolved.`);
    const builders=new Map(directory.builders.map(b=>[b.builderKey,b]));
    for(const era of [...new Set(directory.builders.flatMap(b=>b.eras))].sort((a,b)=>b-a)) $('era').add(new Option(`Era ${era}`,era));
    if(key){
      const thread=await read(`threads/${key}.json`);
      $('title').textContent=thread.displayName;
      $('intro').textContent=`${thread.albums.toLocaleString()} build albums · ${thread.photos.toLocaleString()} photographs`;
      $('filters').hidden=true;$('status').textContent=thread.nameStatus==='ambiguous'?'Several recorded names need review. Searchable aliases are retained.':'';
      for(const era of thread.eras){
        const section=node('details');section.open=true;
        section.append(node('summary',`Era ${era.era} · ${era.albums.length.toLocaleString()} albums`));
        let shown=0;const more=node('button','Show more albums');
        const append=()=>{for(const album of era.albums.slice(shown,shown+40)){
          const card=node('article',null,'album');card.append(node('h3',album.label),node('p',`${album.pieces.toLocaleString()} construction pieces`,'muted'));
          const credits=node('p',null,'credits');credits.append('Contributors: ');
          album.contributors.forEach((c,i)=>{if(i)credits.append(' · ');credits.append(link(builders.get(c.builderKey)?.displayName||'Recorded builder',new URL(`${c.builderKey}/`,base)));if(c.share!=null)credits.append(` (${(100*c.share).toFixed(1)}%)`);});
          card.append(credits,node('p',album.attribution,'muted'));
          const links=node('div',null,'links');
          if(album.galleryUrl)links.append(link('Open original gallery',album.galleryUrl));
          if(album.worldUrl)links.append(link('World view · terrain pending',album.worldUrl));
          card.append(links);
          if(album.photos.length){const photos=node('div',null,'photos');for(const p of album.photos){const a=link('',p.href);const img=node('img');img.src=p.thumb;img.alt=p.label;img.loading='lazy';a.append(img);photos.append(a);}card.append(photos);}
          else card.append(node('p','Photography planned for a future capture session.','muted'));
          section.insertBefore(card,more);
        }shown+=40;more.hidden=shown>=era.albums.length;};
        section.append(more);more.onclick=append;append();$('content').append(section);
      }
    }else{
      $('content').className='directory';let shown=0,filtered=[];
      const append=()=>{for(const b of filtered.slice(shown,shown+80)){const card=node('article',null,'builder');card.append(link(b.displayName,new URL(`${b.builderKey}/`,base)),node('p',b.eras.map(e=>`Era ${e}`).join(' · ')),node('p',`${b.albums.toLocaleString()} albums · ${b.photos.toLocaleString()} photos`));$('content').append(card);}shown+=80;$('more').hidden=shown>=filtered.length;};
      const filter=()=>{const q=$('search').value.trim().toLocaleLowerCase(),era=Number($('era').value);filtered=directory.builders.filter(b=>(!era||b.eras.includes(era))&&[b.displayName,...b.aliases].some(n=>n.toLocaleLowerCase().includes(q)));shown=0;$('content').replaceChildren();$('status').textContent=`${filtered.length.toLocaleString()} builders · ${directory.unattributedAlbums.toLocaleString()} additional albums have no saved creator`;append();};
      $('search').oninput=filter;$('era').onchange=filter;$('more').onclick=append;filter();
    }
  }catch(error){$('status').textContent=error.message;}
})();
