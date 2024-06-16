import React, { useEffect } from 'react';

const backCoverImage = require('../../../../themes/assets/backCover.png');
const classTableDecoration = require('../../../../themes/assets/classTableDecoration.png');

import UIPage from '../basePages/uiPage/uiPage.jsx';

const AssetsPage = (props) => {
    const files = [
        { name: 'backCoverImage', path: backCoverImage },
        { name: 'classTableDecoration', path: classTableDecoration },
    ];

    useEffect(() => {
        // Log file names to the console
        files.forEach((file) => {
            console.log(file);
        });
    }, []);

    const renderAssets = () => {
        return (
            <div className="fileGroup">
                {files.map((file, index) => (
                    <div key={index}>
                        <p>{file.name}</p>
                        <img src={file.path} alt={file.name} />
                    </div>
                ))}
            </div>
        );
    };

    return <UIPage brew={props.brew}>{renderAssets()}</UIPage>;
};

module.exports = AssetsPage;
