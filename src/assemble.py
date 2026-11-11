import json
t=open('template.html').read()
data=open('data.json').read().replace('<','\\u003c')
out=t.replace('/*DATA*/',data).replace('/*CORE*/',open('core.js').read()).replace('/*UI*/',open('ui.js').read())
open('../index.html','w').write(out); print(len(out),'bytes')
