export const selectedPresetId = 'p13';
export const presets = [
  { id:'p01', name:'Broad FAT / tight lowercase', description:'Open, heavy FAT against condensed lowercase. Short ascenders and descenders keep the long word compact.',
    case:'contrast', layout:'line', ratio:1.25,
    fat:{wght:900,wdth:151,opsz:80,XTRA:560,XOPQ:125,YOPQ:100,YTUC:620},
    mat:{wght:500,wdth:60,opsz:60,XTRA:430,XOPQ:80,YOPQ:65,YTLC:520,YTAS:649,YTDE:-98,YTUC:650} },
  { id:'p02', name:'Soft Fat / compact MatRyoshka', description:'Lowercase in both words. Enlarged counters and low contrast make Fat broad and soft; high lowercase height keeps MatRyoshka readable.',
    case:'mixed', layout:'line', ratio:1.65,
    fat:{wght:900,wdth:151,opsz:8,XTRA:570,XOPQ:125,YOPQ:115,YTLC:570,YTAS:649,YTUC:680},
    mat:{wght:550,wdth:50,opsz:48,XTRA:430,XOPQ:75,YOPQ:65,YTLC:540,YTAS:649,YTDE:-98,YTUC:680} },
  { id:'p03', name:'Heavy uprights / fine crossbars', description:'Thick vertical strokes and fine horizontal strokes give FAT a more graphic silhouette. The lower word uses shorter extenders and restrained contrast.',
    case:'contrast', layout:'stack', ratio:1.5,
    fat:{wght:760,wdth:151,opsz:144,XTRA:540,XOPQ:155,YOPQ:35,YTUC:590},
    mat:{wght:450,wdth:65,opsz:96,XTRA:440,XOPQ:100,YOPQ:45,YTLC:535,YTAS:660,YTDE:-110,YTUC:650} },
  { id:'p04', name:'Low, broad and square', description:'Lower uppercase proportions broaden FAT. The lowercase line uses dense counters and short extenders to approach the same width.',
    case:'contrast', layout:'stack', ratio:1.45,
    fat:{wght:900,wdth:151,opsz:30,XTRA:580,XOPQ:125,YOPQ:125,YTUC:528},
    mat:{wght:600,wdth:50,opsz:72,XTRA:410,XOPQ:75,YOPQ:75,GRAD:40,YTLC:550,YTAS:649,YTDE:-98,YTUC:650} },
  { id:'p05', name:'Forward lowercase', description:'Slant carries through the real outlines and the R/1 stem. Width, grade and short extenders keep the long word contained.',
    case:'mixed', layout:'line', ratio:1.65,
    fat:{wght:900,wdth:151,opsz:50,slnt:-10,XTRA:550,XOPQ:120,YOPQ:90,YTLC:570,YTAS:680},
    mat:{wght:500,wdth:55,opsz:80,slnt:-10,XTRA:430,XOPQ:80,YOPQ:65,GRAD:60,YTLC:530,YTAS:649,YTDE:-98,YTUC:650} },
  { id:'p06', name:'Caps pushed further', description:'An uppercase comparison: broad low FAT and narrow tall MATRYOSHKA, with counter width and stroke contrast adjusted independently.',
    case:'caps', layout:'line', ratio:1.1,
    fat:{wght:900,wdth:151,opsz:100,XTRA:580,XOPQ:140,YOPQ:55,YTUC:528},
    mat:{wght:450,wdth:45,opsz:100,XTRA:420,XOPQ:70,YOPQ:65,YTUC:760,GRAD:25} },
  { id:'p07', name:'FAT / MAT / RYO / SHKA', description:'Four centered lines. Each line has its own axes; each of the three gaps has its own spacing slider.',
    case:'caps', layout:'four', ratio:1, gaps:[35,35,35],
    fat:{wght:800,wdth:100,opsz:96,XTRA:480,XOPQ:110,YOPQ:55,YTUC:650},
    mat:{wght:600,wdth:110,opsz:96,XTRA:480,XOPQ:95,YOPQ:55,YTUC:650},
    ryo:{wdth:110}, shka:{wdth:70,XTRA:430} },
  { id:'p08', name:'FAT / MAT / RYOSHKA', description:'Three centered lines. Keep FAT and MAT broad and tune the longer RYOSHKA line independently.',
    case:'caps', layout:'three', ratio:1, gaps:[35,35,35],
    fat:{wght:800,wdth:100,opsz:96,XTRA:480,XOPQ:110,YOPQ:55,YTUC:650},
    mat:{wght:600,wdth:110,opsz:96,XTRA:480,XOPQ:95,YOPQ:55,YTUC:650},
    ryo:{wdth:35,XTRA:380,XOPQ:70,YOPQ:55} },
  { id:'p09', name:'Previous FatMatryoshka wordmark', description:'Selected wordmark: heavy FAT and lighter MATRYOSHKA on one line, with the teal R/1 signature. Exact saved settings, including the alternate line axes.',
    case:'caps', layout:'line', alignment:'left', ratio:1, gaps:[45,45,45],
    fat:{opsz:69,wght:1000,GRAD:150,wdth:25,slnt:0,XOPQ:175,YOPQ:135,XTRA:603,YTUC:650,YTLC:570,YTAS:649,YTDE:-203,YTFI:738},
    mat:{opsz:144,wght:517,GRAD:-139,wdth:151,slnt:0,XOPQ:126,YOPQ:135,XTRA:424,YTUC:650,YTLC:550,YTAS:649,YTDE:-98,YTFI:732},
    ryo:{opsz:72,wght:135,GRAD:-139,wdth:34,slnt:0,XOPQ:126,YOPQ:135,XTRA:432,YTUC:650,YTLC:550,YTAS:649,YTDE:-98,YTFI:732},
    shka:{opsz:72,wght:135,GRAD:-139,wdth:34,slnt:0,XOPQ:126,YOPQ:135,XTRA:432,YTUC:650,YTLC:550,YTAS:649,YTDE:-98,YTFI:732} },
];

// Keep the approved MATRYOSHKA outlines and settings; remove only FAT.
presets.push({...presets.find(preset => preset.id === 'p09'),
  id:'p10', name:'Previous Matryoshka wordmark', layout:'matryoshka',
  description:'Previous wordmark: the original MATRYOSHKA lettering with its teal M and R/1 signature.'});

// Preserve the intermediate shared study.
presets.push({...presets.find(preset => preset.id === 'p10'),
  id:'p11', name:'Narrow wordmark study',
  description:'Intermediate version: narrower lettering, finer uprights and a shorter right T arm. Continue adjusting each letter pair from here.',
  tuning:{at:-23,tr:6,leftArm:89,rightArm:56},
  mat:{opsz:144,wght:597,GRAD:-139,wdth:64,slnt:0,XOPQ:39,YOPQ:121,XTRA:425,YTUC:650,YTLC:550,YTAS:649,YTDE:-98,YTFI:732},
});

// Approved full settings from the shared lab URL, 2026-10-14.
presets.push({...presets.find(preset => preset.id === 'p11'),
  id:'p12', name:'Narrow wordmark without foot',
  description:'Narrow capitals, both T arms at 55%, A–T spacing −23, T–R spacing +6 and the teal R/1 signature.',
  tuning:{ma:0,at:-23,tr:6,ry:0,yo:0,os:0,sh:0,hk:0,ka:0,leftArm:55,rightArm:55},
  mat:{opsz:144,wght:597,GRAD:-139,wdth:64,slnt:0,XOPQ:39,YOPQ:135,XTRA:425,YTUC:650,YTLC:550,YTAS:649,YTDE:-98,YTFI:732},
});

// Add the requested small numeral foot to the otherwise unchanged approved wordmark.
presets.push({...presets.find(preset => preset.id === 'p12'),
  id:'p13', name:'Matryoshka — selected wordmark',
  description:'Current wordmark: the approved narrow capitals and shortened T arms, with a small teal foot completing the R/1.',
  tuning:{...presets.find(preset => preset.id === 'p12').tuning,foot:50},
});
