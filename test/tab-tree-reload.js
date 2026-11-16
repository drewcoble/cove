(async()=>{
 const {__tabTreeExpect:x}=await chrome.storage.local.get('__tabTreeExpect');
 const {rt}=await chrome.storage.session.get('rt');
 const notes=[
  [rt.tabParent[x.leaf]===x.collapsedParent,'tree relationships survive extension reload'],
  [rt.treeCollapsed[`${x.main}:${x.collapsedParent}`]===true,'collapsed branches survive extension reload'],
  [!rt.tabParent[x.detail]&&rt.treeDetached[x.detail]===true,'manual detach survives reload instead of re-adopting the Chrome opener'],
  [!rt.tabParent[(await chrome.tabs.getCurrent()).id],'extension UI does not become a child of a web tab'],
 ];
 return notes.map(([ok,label])=>`${ok?'PASS':'FAIL'} ${label}`).join('\n');
})()
