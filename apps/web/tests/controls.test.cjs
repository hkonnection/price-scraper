const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/** Load real components and publication formatters with deterministic hooks. */
function component(file, navigations) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/app/components',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText, {
    exports, URLSearchParams,
    require(name) {
      if(name==='react') return {useState:value=>[value,()=>{}],useTransition:()=>[false,callback=>callback()]};
      if(name==='next/navigation') return {useRouter:()=>({replace:url=>navigations.push(url)})};
      if(name==='../publication') return component('../publication.ts',navigations);
      if(name==='react/jsx-runtime') return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
      return {default:file==='DealsPageClient.tsx'&&name==='./DealsTable'?'tableComponent':'unused'};
    },
  });
  return file.endsWith('.tsx') ? exports.default : exports;
}

/** Walk a rendered JSX tree to find controls. */
function nodes(tree) {
  if(!tree || typeof tree!=='object') return [];
  const children=tree.props?.children;
  return [tree,...(Array.isArray(children)?children:[children]).flatMap(nodes)];
}

const props={deals:[],retailers:[{id:1,name:'Synthetic Costco',slug:'costco',scrape_source:'scraper'}],retailerDates:{},flyerDates:null,
  total:2106,avgSavings:30,topSaving:30,categories:['Category 0','Category 1'],promoTypes:['Type 0','Type 1'],
  retailerSlug:'costco',category:'all',promo:'all',sort:'savings_percent',direction:'desc',size:500,offset:500,publication:'[[1,10]]',publicationReset:false};

test('real client controls request server filters, sizes, offsets, sorts and publication scope',()=>{
  const navigation=[]; const tree=nodes(component('DealsPageClient.tsx',navigation)(props));
  const byId=id=>tree.find(node=>node.props?.id===id);
  byId('category-filter').props.onChange({target:{value:'Category 1'}});
  let query=new URL(navigation.pop(),'http://localhost').searchParams;
  assert.equal(query.get('category'),'Category 1');assert.equal(query.get('offset'),'0');assert.equal(query.get('publication'),'[[1,10]]');
  byId('promo-filter').props.onChange({target:{value:'Type 1'}});
  assert.equal(new URL(navigation.pop(),'http://localhost').searchParams.get('promo'),'Type 1');
  byId('page-size').props.onChange({target:{value:'1000'}});
  query=new URL(navigation.pop(),'http://localhost').searchParams;
  assert.equal(query.get('size'),'1000');assert.equal(query.get('offset'),'0');
  tree.find(node=>node.type==='button'&&String(node.props.children).includes('Next')).props.onClick();
  query=new URL(navigation.pop(),'http://localhost').searchParams;
  assert.equal(query.get('offset'),'1000');assert.equal(query.get('publication'),'[[1,10]]');
  tree.find(node=>node.type==='button'&&String(node.props.children).includes('Prev')).props.onClick();
  assert.equal(new URL(navigation.pop(),'http://localhost').searchParams.get('offset'),'0');
  tree.find(node=>node.type==='tableComponent').props.onSort('sale_price','asc');
  query=new URL(navigation.pop(),'http://localhost').searchParams;
  assert.equal(query.get('sort'),'sale_price');assert.equal(query.get('direction'),'asc');assert.equal(query.get('offset'),'0');
  byId('retailer-filter').props.onChange({target:{value:'all'}});
  query=new URL(navigation.pop(),'http://localhost').searchParams;
  assert.equal(query.get('retailer'),'all');assert.equal(query.get('category'),'all');assert.equal(query.get('promo'),'all');assert.equal(query.has('publication'),false);
});

/** Verify every retained header matches its cells without publication timestamps. */
test('real table omits publication cells and aligns single-store and all-store columns',()=>{
  const base={product_name:'Synthetic product',category:'Other',regular_price:100,sale_price:20,savings_amount:80,savings_percent:80,in_stock:1,retailer_slug:'costco',retailer_name:'Synthetic Costco'};
  const deals=[
    {...base,id:1,scrape_id:10,published_at:'2026-10-01T12:00:00Z',scraped_at:'2026-09-30'},
    {...base,id:2,scrape_id:10,published_at:null,scraped_at:'bad'},
    {...base,id:3,scrape_id:null,published_at:null,scraped_at:'2026-06-01'},
  ];
  for(const showRetailer of [false,true]) {
    const tree=nodes(component('DealsTable.tsx',[])({deals,showRetailer,sortKey:'sale_price',sortDirection:'desc',pending:false,onSort:()=>{}}));
    const headers=tree.filter(node=>node.type==='th').map(node=>node.props.children);
    assert.deepEqual(headers,[...(showRetailer?['Retailer']:[]),'Product','Category','Regular','Sale','$ Off','% Off']);
    const rows=tree.filter(node=>node.type==='tr').slice(1);
    assert.equal(rows.length,deals.length);
    for(const row of rows) {
      const cells=nodes(row).filter(node=>node.type==='td');
      assert.equal(cells.length,headers.length);
      const contents=cells.map(cell=>nodes(cell).flatMap(node=>node.props?.children).filter(value=>typeof value==='string').join(''));
      assert.deepEqual(contents,[...(showRetailer?['Synthetic Costco']:[]),'Synthetic product','Other','$100.00','$20.00','$80.00','80%']);
      assert.ok(!nodes(row).some(node=>node.props?.className==='updated-cell'));
    }
    assert.doesNotMatch(JSON.stringify(tree),/Publication \/ observation|Last published:|Observed \(legacy\):|2026-/);
    const empty=nodes(component('DealsTable.tsx',[])({deals:[],showRetailer,sortKey:'sale_price',sortDirection:'desc',pending:false,onSort:()=>{}}));
    assert.equal(empty.filter(node=>node.type==='table').length,0);
    assert.ok(empty.some(node=>node.type==='p'&&node.props.children.includes('No deals found')));
  }
});

test('real table sends sort changes instead of sorting the current page',()=>{
  const sorts=[]; const deal={id:2,product_name:'Synthetic',category:'Other',regular_price:100,sale_price:20,savings_amount:80,savings_percent:80,in_stock:1};
  const tree=nodes(component('DealsTable.tsx',[])( {deals:[deal],lastUpdated:null,sortKey:'sale_price',sortDirection:'desc',pending:false,onSort:(...args)=>sorts.push(args)} ));
  tree.find(node=>node.type==='th'&&node.props.children==='Sale').props.onClick();
  tree.find(node=>node.type==='th'&&node.props.children==='Product').props.onClick();
  assert.deepEqual(sorts,[['sale_price','asc'],['product_name','asc']]);
  const pending=nodes(component('DealsTable.tsx',[])({deals:[deal],lastUpdated:null,sortKey:'sale_price',sortDirection:'desc',pending:true,onSort:()=>assert.fail('No double navigation')}));
  pending.find(node=>node.type==='th'&&node.props.children==='Sale').props.onClick();
});
