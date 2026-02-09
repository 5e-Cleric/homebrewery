import React from 'react';
import './brewUtils.less';

import BrewCleanup from './brewCleanup/brewCleanup.jsx';
import BrewLookup from './brewLookup/brewLookup.jsx';
import BrewCompress from './brewCompress/brewCompress.jsx';s

const BrewUtils = ()=>{
	return (
		<>
			<BrewLookup />
			<hr />
			<BrewCleanup />
			<hr />
			<BrewCompress />
		</>
	);
};
export default BrewUtils;
