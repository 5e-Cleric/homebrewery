/* eslint-disable no-restricted-syntax, max-lines */

import { model as HomebrewModel }     from './homebrew.model.js';
import { model as NotificationModel } from './notifications.model.js';
import express    from 'express';
import Moment     from 'moment';
import zlib       from 'zlib';
import templateFn from '../client/template.js';

import HomebrewAPI  from './homebrew.api.js';
import asyncHandler from 'express-async-handler';
import { splitTextStyleAndMetadata } from '../shared/helpers.js';

const router = express.Router();


process.env.ADMIN_USER = process.env.ADMIN_USER || 'admin';
process.env.ADMIN_PASS = process.env.ADMIN_PASS || 'password3';

const mw = {
	adminOnly : (req, res, next)=>{
		if(!req.get('authorization')){
			return res
				.set('WWW-Authenticate', 'Basic realm="Authorization Required"')
				.status(401)
				.send('Authorization Required');
		}
		const [username, password] = Buffer.from(req.get('authorization').split(' ').pop(), 'base64')
			.toString('ascii')
			.split(':');
		if(process.env.ADMIN_USER === username && process.env.ADMIN_PASS === password){
			return next();
		}
		throw { HBErrorCode: '52', code: 401, message: 'Access denied' };
	}
};

const junkBrewPipeline = [
	{	$match : {
		updatedAt  : { $lt: Moment().subtract(30, 'days').toDate() },
		lastViewed : { $lt: Moment().subtract(30, 'days').toDate() }
	} },
	{ $project: { textBinSize: { $binarySize: '$textBin' } } },
	{ $match: { textBinSize: { $lt: 140 } } },
	{ $limit: 100 }
];

/* Search for brews that aren't compressed (missing the compressed text field) */
const uncompressedBrewQuery = HomebrewModel.find({
	'text' : { '$exists': true }
}).lean().limit(10000).select('_id');

// Search for up to 100 brews that have not been viewed or updated in 30 days and are shorter than 140 bytes
router.get('/admin/cleanup', mw.adminOnly, (req, res)=>{
	HomebrewModel.aggregate(junkBrewPipeline).option({ maxTimeMS: 60000 })
		.then((objs)=>res.json({ count: objs.length }))
		.catch((error)=>{
			console.error(error);
			res.status(500).json({ error: 'Internal Server Error' });
		});
});

// Delete up to 100 brews that have not been viewed or updated in 30 days and are shorter than 140 bytes
router.post('/admin/cleanup', mw.adminOnly, (req, res)=>{
	HomebrewModel.aggregate(junkBrewPipeline).option({ maxTimeMS: 60000 })
		.then((docs)=>{
			const ids = docs.map((doc)=>doc._id);
			return HomebrewModel.deleteMany({ _id: { $in: ids } });
		}).then((result)=>{
			res.json({ count: result.deletedCount });
		}).catch((error)=>{
			console.error(error);
			res.status(500).json({ error: 'Internal Server Error' });
		});
});

/* Searches for matching edit or share id, also attempts to partial match */
router.get('/admin/lookup/:id', mw.adminOnly, asyncHandler(HomebrewAPI.getBrew('admin', false)), async (req, res, next)=>{
	return res.json(req.brew);
});

/* Find 50 brews that aren't compressed yet */
router.get('/admin/finduncompressed', mw.adminOnly, (req, res)=>{
	const query = uncompressedBrewQuery.clone();

	query.exec()
		.then((objs)=>{
			const ids = objs.map((obj)=>obj._id);
			res.json({ count: ids.length, ids });
		})
		.catch((err)=>{
			console.error(err);
			res.status(500).send(err.message || 'Internal Server Error');
		});
});

/* Cleans `<script` and `</script>` from the "text" field of a brew */
router.put('/admin/clean/script/:id', asyncHandler(HomebrewAPI.getBrew('admin', false)), async (req, res)=>{
	console.log(`[ADMIN: ${req.account?.username || 'Not Logged In'}] Cleaning script tags from ShareID ${req.params.id}`);

	function cleanText(text){return text.replaceAll(/(<\/?s)cript/gi, '');};

	const brew = req.brew;

	const properties = ['text', 'description', 'title'];
	properties.forEach((property)=>{
		brew[property] = cleanText(brew[property]);
	});

	splitTextStyleAndMetadata(brew);

	req.body = brew;

	// Remove Account from request to prevent Admin user from being added to brew as an Author
	req.account = undefined;

	return await HomebrewAPI.updateBrew(req, res);
});

/* Get list of a user's documents */
router.get('/admin/user/list/:user', mw.adminOnly, async (req, res)=>{
	const username = req.params.user;
	const fields = { _id: 0, text: 0, textBin: 0 };		// Remove unnecessary fields from document lists

	console.log(`[ADMIN: ${req.account?.username || 'Not Logged In'}] Get brew list for ${username}`);

	const brews = await HomebrewModel.getByUser(username, true, fields);

	return res.json(brews);
});

/* Compresses the "text" field of a brew to binary */
router.put('/admin/compress/:id', (req, res)=>{
	HomebrewModel.findOne({ _id: req.params.id })
		.then((brew)=>{
			if(!brew)
				return res.status(404).send('Brew not found');

			if(brew.text) {
				brew.textBin = brew.textBin || zlib.deflateRawSync(brew.text);	//Don't overwrite textBin if exists
				brew.text = undefined;
			}

			return brew.save();
		})
		.then((obj)=>res.status(200).send(obj))
		.catch((err)=>{
			console.error(err);
			res.status(500).send('Error while saving');
		});
});

router.get('/admin/stats', mw.adminOnly, async (req, res)=>{
	const stat  = req.query.stat;
	switch (stat) {
	case 'totalPublished':
		try {
			const publishedBrewsCount = await HomebrewModel.countDocuments({ published: 'true' });
			console.log(publishedBrewsCount);
			console.log(HomebrewModel);
			return res.json(publishedBrewsCount);
		} catch (error) {
			console.error('Failed to get publishedBrewsCount:', error);
		}
		break;
	case 'totalUnauthored':
		try {
			const unauthoredBrewsCount = await HomebrewModel.countDocuments({ authors: [] });
			return res.json(unauthoredBrewsCount);
		} catch (error) {
			console.error('Failed to get unauthoredBrewsCount:', error);
		}
		break;
	case 'totalInGoogle':
		try {
			const googleBrewsCount = await HomebrewModel.countDocuments({ googleId: { '$exists': true } });
			return res.json(googleBrewsCount);
		} catch (error) {
			console.error('Failed to get nonGoogleBrewsCount:', error);
		}
		break;
	case 'totalThumbnail':
		try {
			const totalThumbnailCount = await HomebrewModel.countDocuments({ thumbnail: { '$exists': true,  '$ne': '' } });
			return res.json(totalThumbnailCount);
		} catch (error) {
			console.error('Failed to get totalThumbnailCount:', error);
		}
		break;
	case 'totalBrews':
		try {
			const totalBrewsCount = await HomebrewModel.estimatedDocumentCount();
			console.log(totalBrewsCount);
			return res.json(totalBrewsCount);
		} catch (error) {
			console.error('Failed to get totalBrewsCount:', error);
		}
		break;
	default:
		break;

	}

});

router.get('/admin/brewsByDate', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.getDocumentCountsByDate();
		res.json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByLang', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.getDocumentCountsByLang();
		const mergeLanguageCounts = (data)=>{
			const merged = data.reduce((acc, item)=>{
				const normalizedId = String(item._id || 'en').trim().toLowerCase();
				acc[normalizedId] = (acc[normalizedId] || 0) + item.count;
				return acc;
			}, {});

			return Object.entries(merged).map(([key, count])=>({ _id: key, count }));
		};
		 const mergedData = mergeLanguageCounts(data);

		res.json(mergedData);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByPageCount', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.getDocumentCountsByPageCount();
		res.json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByVersion', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.getDocumentCountsByVersion();
		res.json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByViews', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.getDocumentCountsByViews();
		res.json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsBySystems', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.getDocumentCountsBySystems();
		const counts = {};

		data.forEach(({ _id, count })=>{
			const uniqueSortedId = [...new Set(_id)].sort().join(',');
			counts[uniqueSortedId] = (counts[uniqueSortedId] || 0) + count;
		});

		const result = Object.keys(counts).map((key)=>({
			_id   : key.split(','),
			count : counts[key]
		}));

		console.table(result);
		res.json(result);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByUpdated-Created', mw.adminOnly, async (req, res)=>{
	try {
		const brewsByDateDifference = await HomebrewModel.aggregate([
			{
				$addFields : {
					dateDifferenceInDays : {
						$dateDiff : {
							startDate : '$createdAt',
							endDate   : '$updatedAt',
							unit      : 'day'
						}
					}
				}
			},
			{
				$bucket : {
					groupBy    : '$dateDifferenceInDays',
					boundaries : [0, 30, 90, 365, 730, 1095, 1460, 1825, 2190, 2555, 2920, 3650],
					default    : 'Over 9 years',
					output     : {
						count : { $sum: 1 }
					}
				}
			},
			{
				$sort : { '_id': 1 }
			}
		], { maxTimeMS: 30000 });

		const labelMap = new Map([
			[1, 'Under 1 day'],
			[30, 'Under 1 month'],
			[90, '1 to 3 months'],
			[365, '3 months to 1 year'],
			[730, '1 to 2 years'],
			[1095, '2 to 3 years'],
			[1460, '3 to 4 years'],
			[1825, '4 to 5 years'],
			[2190, '5 to 6 years'],
			[2555, '6 to 7 years'],
			[2920, '7 to 8 years'],
			[3650, '8 to 9 years']
		]);

		// Map the _id values to their meaningful labels
		const labeledBrews = brewsByDateDifference.map((item)=>{
			for (const boundary of labelMap.keys()) {
				if(item._id <= boundary) {
					item._id = labelMap.get(boundary);
					break;
				}
			}
			return item;
		});

		return res.json(labeledBrews);

	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByPageVsVersion', mw.adminOnly, async (req, res)=>{
	try {
		const pageVsVersion = await HomebrewModel.aggregate([
			{
				$match : {
					pageCount : { $gt: 0 },
					version   : { $gte: 0 }
				}
			},
			{
				$project : {
					ratio : { $divide: ['$version', '$pageCount'] }
				}
			},
			{
				$group : {
					_id   : '$ratio',
					count : { $sum: 1 }
				}
			},
			{ $sort: { _id: 1 } }
		], { maxTimeMS: 30000, hint: { pageCount: 1, version: 1 } });

		const boundaries = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1, 2, 5, 10];
		const defaultLabel = '10+';

		const groupByBuckets = (data)=>{
			const buckets = {};
			data.forEach(({ count, _id })=>{
				let key = defaultLabel;
				for (let i = 0; i < boundaries.length - 1; i++)
					if(_id >= boundaries[i] && _id < boundaries[i + 1]) {
						key = `${boundaries[i]}-${boundaries[i + 1] - 1} ratio of version / page count`;
						break;
					}
				buckets[key] = buckets[key] || { count: 0, authors: [] };
				buckets[key].count++;
				buckets[key].authors.push(_id);
			});
			return Object.entries(buckets)
				.map(([key, val])=>({ _id: key, count: val.count }))
				.sort((a, b)=>{
					const numA = parseInt(a._id);
					const numB = parseInt(b._id);
					return numA - numB;
				});
		};

		const brews = groupByBuckets(pageVsVersion);
		console.log(brews);

		return res.json(brews);

	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});


router.get('/admin/brewsByAuthor', mw.adminOnly, async (req, res)=>{
	try {
		const authoredBrews = await HomebrewModel.aggregate([
			{
				$match : {
					authors : { $exists: true },
					authors : { $ne: [] },
				}
			},
			{
				$project : {
  					owner : { $arrayElemAt: ['$authors', 0] }
				}
			},
			{
				$group : {
					_id   : '$owner',
					count : { $sum: 1 }
				}
			},
			{ $sort: { _id: 1 } }
		], { maxTimeMS: 30000 });

		const boundaries = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
		const defaultLabel = '1000+';

		const groupByBuckets = (data)=>{
			const buckets = {};
			data.forEach(({ count, _id })=>{
				let key = defaultLabel;
				for (let i=0; i<boundaries.length-1; i++)
					if(count >= boundaries[i] && count < boundaries[i+1]) {
						key = `${boundaries[i]}-${boundaries[i+1]-1}`;
						break;
					}
				buckets[key] = buckets[key] || { count: 0, authors: [] };
				buckets[key].count++;
				buckets[key].authors.push(_id);
			});
			return Object.entries(buckets)
  			.map(([key, val])=>({ _id: key, count: val.count }))
  			.sort((a, b)=>{
  				const numA = parseInt(a._id);
  				const numB = parseInt(b._id);
  				return numA - numB;
  			});
		};
		const brews = groupByBuckets(authoredBrews);
		console.log(brews);

		return res.json(brews);

	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByDateAndAuthor', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.aggregate([
			{
				$match : {
					authors   : { $exists: true, $ne: [] },
					createdAt : { $exists: true }
				}
			},
			{
				$project : {
					owner     : { $arrayElemAt: ['$authors', 0] },
					createdAt : 1
				}
			},
			{
				$sort : { createdAt: 1 }
			},
			{
				$group : {
					_id       : '$owner',
					firstDate : { $first: '$createdAt' }
				}
			},
			{
				$group : {
					_id   : { $dateToString: { format: '%Y-%m', date: '$firstDate' } },
					count : { $sum: 1 }
				}
			},
			{
				$sort : { _id: 1 }
			}
		], { maxTimeMS: 30000 });

		res.json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});

router.get('/admin/brewsByAuthorsDuration', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.aggregate([
			{
				$project : {
					authors   : 1,
					createdAt : 1,
					updatedAt : 1
				}
			},
			{
				$match : {
					authors   : { $exists: true, $ne: [] },
					createdAt : { $exists: true, $ne: null },
					updatedAt : { $exists: true, $ne: null }
				}
			},
			{
				$group : {
					_id        : { $arrayElemAt: ['$authors', 0] },
					firstDate  : { $min: '$createdAt' },
					lastUpdate : { $max: '$updatedAt' }
				}
			},
			{
				$project : {
					durationMonths : {
						$floor : {
							$divide : [
								{ $subtract: ['$lastUpdate', '$firstDate'] },
								1000 * 60 * 60 * 24 * 30
							]
						}
					}
				}
			},

			{
				$bucket : {
					groupBy    : '$durationMonths',
					boundaries : [1, 6, 12, 24, 48, 72, 96, 120, 130],
					default    : 'null duration (not sure how it is possible yet',
					output     : { count: { $sum: 1 } }
				}
			},

		], { maxTimeMS: 120000, allowDiskUse: true });

		console.log(data);

		res.json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});


// #######################   LOCKS

router.get('/api/lock/count', mw.adminOnly, asyncHandler(async (req, res)=>{

	const countLocksQuery = {
		lock : { $exists: true }
	};
	const count = await HomebrewModel.countDocuments(countLocksQuery)
		.catch((error)=>{
			throw { name: 'Lock Count Error', message: 'Unable to get lock count', status: 500, HBErrorCode: '61', error };
		});

	return res.json({ count });

}));

router.get('/api/locks', mw.adminOnly, asyncHandler(async (req, res)=>{
	const countLocksPipeline = [
		{
			  $match :
				{
				  'lock' : { '$exists': 1 }
				},
		},
		{
			$project : {
				shareId : 1,
				editId  : 1,
				title   : 1,
				lock    : 1
			}
		}
	];
	const lockedDocuments = await HomebrewModel.aggregate(countLocksPipeline)
		.catch((error)=>{
			throw { name: 'Can Not Get Locked Brews', message: 'Unable to get locked brew collection', status: 500, HBErrorCode: '68', error };
		});
	return res.json({
		lockedDocuments
	});

}));

router.post('/api/lock/:id', mw.adminOnly, asyncHandler(async (req, res)=>{

	const lock = req.body;

	lock.applied = new Date;

	const filter = {
		shareId : req.params.id
	};

	const brew = await HomebrewModel.findOne(filter);

	if(!brew) throw { name: 'Brew Not Found', message: 'Cannot find brew to lock', shareId: req.params.id, status: 500, HBErrorCode: '63' };

	if(brew.lock && !lock.overwrite) {
		throw { name: 'Already Locked', message: 'Lock already exists on brew', shareId: req.params.id, title: brew.title, status: 500, HBErrorCode: '64' };
	}

	lock.overwrite = undefined;

	brew.lock = lock;
	brew.markModified('lock');

	await brew.save()
		.catch((error)=>{
			throw { name: 'Lock Error', message: 'Unable to set lock', shareId: req.params.id, status: 500, HBErrorCode: '62', error };
		});

	return res.json({ name: 'LOCKED', message: `Lock applied to brew ID ${brew.shareId} - ${brew.title}`, ...lock });

}));

router.put('/api/unlock/:id', mw.adminOnly, asyncHandler(async (req, res)=>{

	const filter = {
		shareId : req.params.id
	};

	const brew = await HomebrewModel.findOne(filter);

	if(!brew) throw { name: 'Brew Not Found', message: 'Cannot find brew to unlock', shareId: req.params.id, status: 500, HBErrorCode: '66' };

	if(!brew.lock) throw { name: 'Not Locked', message: 'Cannot unlock as brew is not locked', shareId: req.params.id, status: 500, HBErrorCode: '67' };

	brew.lock = undefined;
	brew.markModified('lock');

	await brew.save()
		.catch((error)=>{
			throw { name: 'Cannot Unlock', message: 'Unable to clear lock', shareId: req.params.id, status: 500, HBErrorCode: '65', error };
		});

	return res.json({ name: 'Unlocked', message: `Lock removed from brew ID ${req.params.id}` });
}));

router.get('/api/lock/reviews', mw.adminOnly, asyncHandler(async (req, res)=>{
	const countReviewsPipeline = [
		{
			  $match :
				{
				  'lock.reviewRequested' : { '$exists': 1 }
				},
		},
		{
			$project : {
				shareId : 1,
				editId  : 1,
				title   : 1,
				lock    : 1
			}
		}
	];
	const reviewDocuments = await HomebrewModel.aggregate(countReviewsPipeline)
		.catch((error)=>{
			throw { name: 'Can Not Get Reviews', message: 'Unable to get review collection', status: 500, HBErrorCode: '68', error };
		});
	return res.json({
		reviewDocuments
	});

}));

router.put('/api/lock/review/request/:id', asyncHandler(async (req, res)=>{
	// === This route is NOT Admin only ===
	// Any user can request a review of their document
	const filter = {
		shareId : req.params.id,
		lock    : { $exists: 1 }
	};

	const brew = await HomebrewModel.findOne(filter);
	if(!brew) { throw { name: 'Brew Not Found', message: `Cannot find a locked brew with ID ${req.params.id}`, code: 500, HBErrorCode: '70' }; };

	if(brew.lock.reviewRequested){
		throw { name: 'Review Already Requested', message: `Review already requested for brew ${brew.shareId} - ${brew.title}`, code: 500, HBErrorCode: '71' };
	};

	brew.lock.reviewRequested = new Date();
	brew.markModified('lock');

	await brew.save()
		.catch((error)=>{
			throw { name: 'Can Not Set Review Request', message: `Unable to set request for review on brew ID ${req.params.id}`, code: 500, HBErrorCode: '69', error };
		});

	return res.json({ name: 'Review Requested', message: `Review requested on brew ID ${brew.shareId} - ${brew.title}` });

}));

router.put('/api/lock/review/remove/:id', mw.adminOnly, asyncHandler(async (req, res)=>{

	const filter = {
		shareId                : req.params.id,
		'lock.reviewRequested' : { $exists: 1 }
	};

	const brew = await HomebrewModel.findOne(filter);
	if(!brew) { throw { name: 'Can Not Clear Review Request', message: `Brew ID ${req.params.id} does not have a review pending!`, HBErrorCode: '73' }; };

	brew.lock.reviewRequested = undefined;
	brew.markModified('lock');

	await brew.save()
		.catch((error)=>{
			throw { name: 'Can Not Clear Review Request', message: `Unable to remove request for review on brew ID ${req.params.id}`, HBErrorCode: '72', error };
		});

	return res.json({ name: 'Review Request Cleared', message: `Review request removed for brew ID ${brew.shareId} - ${brew.title}` });

}));

/*
router.get('/admin/brewsByMissingField', mw.adminOnly, async (req, res)=>{
	try {
		const data = await HomebrewModel.getDocumentCountsByMissingField();
		console.log(data);
		res.json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal Server Error' });
	}
});
*/
// #######################   NOTIFICATIONS

router.get('/admin/notification/all', async (req, res, next)=>{
	try {
		const notifications = await NotificationModel.getAll();
		return res.json(notifications);

	} catch (error) {
		console.log('Error getting all notifications: ', error.message);
		return res.status(500).json({ message: error.message });
	}
});

router.post('/admin/notification/add', mw.adminOnly, async (req, res, next)=>{
	try {
		const notification = await NotificationModel.addNotification(req.body);
		return res.status(201).json(notification);
	} catch (error) {
		console.log('Error adding notification: ', error.message);
		return res.status(500).json({ message: error.message });
	}
});

router.delete('/admin/notification/delete/:id', mw.adminOnly, async (req, res, next)=>{
	try {
		const notification = await NotificationModel.deleteNotification(req.params.id);
		return res.json(notification);
	} catch (error) {
		console.error('Error deleting notification: { key: ', req.params.id, ' error: ',  error.message, ' }');
		return res.status(500).json({ message: error.message });
	}
});

router.get('/admin', mw.adminOnly, (req, res)=>{
	templateFn('admin', {
		url : req.originalUrl
	})
	.then((page)=>res.send(page))
	.catch((err)=>{
		console.log(err);
		res.sendStatus(500);
	});
});

export default router;
