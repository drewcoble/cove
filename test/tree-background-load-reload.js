(async()=>{
  const {__treeLoad:x}=await chrome.storage.local.get('__treeLoad');const {rt}=await chrome.storage.session.get('rt');
  return [
    [rt.tabParent[x.child]===x.parent,'tree recovery survives SPA and document navigation without saved tab URLs'],
    [rt.treeCollapsed[`${x.spaceId}:${x.parent}`]===true,'debounced collapsed state survives extension reload'],
  ].map(([pass,label])=>`${pass?'PASS':'FAIL'} ${label}`).join('\n');
})()
