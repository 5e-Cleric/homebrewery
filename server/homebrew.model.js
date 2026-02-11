import mongoose   from 'mongoose';
import { nanoid } from 'nanoid';
import _          from 'lodash';
import zlib       from 'zlib';


const HomebrewSchema = mongoose.Schema({
	shareId   : { type: String, default: ()=>{return nanoid(12);}, index: { unique: true } },
	editId    : { type: String, default: ()=>{return nanoid(12);}, index: { unique: true } },
	googleId  : { type: String, index: true },
	title     : { type: String, default: '', index: true },
	text      : { type: String, default: '' },
	textBin   : { type: Buffer },
	pageCount : { type: Number, default: 1, index: true },

	description    : { type: String, default: '' },
	tags           : { type: [String], index: true },
	systems        : [String],
	lang           : { type: String, default: 'en', index: true },
	renderer       : { type: String, default: '', index: true },
	authors        : { type: [String], index: true },
	invitedAuthors : [String],
	published      : { type: Boolean, default: false, index: true },
	thumbnail      : { type: String, default: '', index: true },

	createdAt  : { type: Date, default: Date.now, index: true },
	updatedAt  : { type: Date, default: Date.now, index: true },
	lastViewed : { type: Date, default: Date.now, index: true },
	views      : { type: Number, default: 0 },
	version    : { type: Number, default: 1, index: true },

	lock : { type: Object, index: true }
}, { versionKey: false });

HomebrewSchema.statics.increaseView = async function(query) {
	const brew = await Homebrew.findOne(query).exec();
	brew.lastViewed = new Date();
	brew.views = brew.views + 1;
	await brew.save()
	.catch((err)=>{
		return err;
	});
	return brew;
};

// STATIC FUNCTIONS

HomebrewSchema.statics.get = async function(query, fields=null){
	const brew = await Homebrew.findOne(query, fields).orFail()
		.catch((error)=>{throw 'Can not find brew';});
	if(!_.isNil(brew.textBin)) {			// Uncompress zipped text field
		const unzipped = zlib.inflateRawSync(brew.textBin);
		brew.text = unzipped.toString();
	}
	return brew;
};

HomebrewSchema.statics.getByUser = async function(username, allowAccess=false, fields=null, filter=null){
	const query = { authors: username, published: true, ...filter };
	if(allowAccess){
		delete query.published;
	}
	const brews = await Homebrew.find(query, fields).lean().exec() //lean() converts results to JSObjects
		.catch((error)=>{throw 'Can not find brews';});
	return brews;
};

HomebrewSchema.statics.getDocumentCountsByDate = async function() {
	return this.aggregate([
		{
			// Ensures index usage, even if ultimately useless, do not remove
			$sort : { createdAt: 1 }
		},
		{
			$group : {
				_id   : { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
				count : { $sum: 1 }
			}
		},
		{
			// Sort by date ascending
			$sort : { _id: 1 }
		}
	], { maxTimeMS: 30000 });
};

HomebrewSchema.statics.getDocumentCountsByLang = async function() {
	return this.aggregate([
		{
			$sort : { 'lang': 1 }
		}, {
			$group : {
				_id   : '$lang',
				count : { $sum: 1 }
			}
		}
	], { maxTimeMS: 30000 });
};

HomebrewSchema.statics.getDocumentCountsByPageCount = async function() {
	return this.aggregate([
		{ $match: { pageCount: { $lte: 50 } } },
		{
			$group : {
				_id   : '$pageCount',
				count : { $sum: 1 }
			}
		},
		{
			$sort : { _id: 1 }
		},

	], { maxTimeMS: 30000 });
};

HomebrewSchema.statics.getDocumentCountsByVersion = async function() {
	const results = await this.aggregate([
		{ $match: { version: { $ne: null } } },
		{
			$bucket : {
				groupBy    : '$version',
				boundaries : [
					1, 5, 10, 20, 40, 60, 80, 100,
					200, 300, 400, 500, 600, 700, 800, 900, 1000,
					10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000
				],
				default : 'Unknown',
				output  : { count: { $sum: 1 } }
			}
		},
		{ $sort: { _id: 1 } }
	], { maxTimeMS: 30000 });

	// Map bucket values to meaningful labels
	const labels = [
		'Below 1', '1-4', '5-9', '10-19', '20-39', '40-59', '60-79', '80-99',
		'100-199', '200-299', '300-399', '400-499', '500-599', '600-699', '700-799', '800-899', '900-999',
		'1000+', '10000+', '20000+', '30000+', '40000+', '50000+', '60000+', '70000+', '80000+', '90000+'
	];

	const finishedCount =  results.map((item, index)=>({
		_id   : labels[index] || 'Unknown',
		count : item.count
	}));

	console.log(finishedCount);
	return finishedCount;
};


HomebrewSchema.statics.getDocumentCountsByViews = async function() {
	return this.aggregate([
		{ $match: { views: { $ne: null, $lte: 50 }  } },
		{
			$group : {
				_id   : '$views',
				count : { $sum: 1 }
			}
		},
		{
			$sort : { _id: 1 }
		}
	], { maxTimeMS: 30000 });
};

HomebrewSchema.statics.getDocumentCountsBySystems = async function() {
	return this.aggregate([
		{ $match: { systems: { $ne: [] } } },
		{
			$group : {
				_id   : '$systems',
				count : { $sum: 1 }
			}
		},
		{ $sort: { _id: 1 } }
	], { maxTimeMS: 30000 });
};


HomebrewSchema.statics.getDocumentCountsByTags = async function() {
	return this.aggregate([
		{ $match: { tags: { $ne: [] } } },
		{
			$group : {
				_id   : '$tags',
				count : { $sum: 1 }
			}
		},
		{ $sort: { _id: 1 } }
	], { maxTimeMS: 30000 });
};


/* Only works in local, takes longer than a minute
Homebrew.getDocumentCountsByMissingField = async function() {
	// Step 1: Get unique field names
	const allFields = await this.aggregate([
		{ $project: { fields: { $objectToArray: '$$ROOT' } } },
		{ $unwind: '$fields' },
		{ $group: { _id: '$fields.k' } }
	]).then((res)=>[...new Set(res.map((field)=>field._id))]); // Ensure uniqueness

	// Step 2: Count missing fields using separate queries and format output for mapping
	const missingCounts = await Promise.all(
		allFields.map(async (field)=>{
			const count = await this.countDocuments({ [field]: { $exists: false } });
			return { _id: field, count };
		})
	);
	missingCounts.sort((a, b)=>b.count - a.count);

	return missingCounts; // Format: [{ _id: field, count: missingCount }, ...]
};
*/
// INDEXES

HomebrewSchema.index({ updatedAt: -1, lastViewed: -1 });
HomebrewSchema.index({ published: 1, title: 'text' });

HomebrewSchema.index({ lock: 1, sparse: true });
HomebrewSchema.path('lock.reviewRequested').index({ sparse: true });


const Homebrew = mongoose.model('Homebrew', HomebrewSchema);

export {
	HomebrewSchema as schema,
	Homebrew       as model
};
